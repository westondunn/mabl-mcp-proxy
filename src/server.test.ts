import { EventEmitter } from "node:events";
import http from "node:http";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

import { createServer, CreateServerResult } from "./server";
import { MablCli } from "./mablCli";

// Mock metrics to avoid prom-client side effects
vi.mock("./metrics", () => {
  const mockRegistry = {
    contentType: "text/plain",
    metrics: vi.fn(async () => "# HELP test\ntest_metric 1"),
    resetMetrics: vi.fn(),
  };
  return {
    forwardedMessagesCounter: { inc: vi.fn() },
    getRegistry: vi.fn(() => mockRegistry),
    httpRequestDurationSeconds: {
      startTimer: vi.fn(() => vi.fn()),
    },
    pendingRequestsGauge: { set: vi.fn() },
    sseClientsGauge: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
  };
});

// Mock package.json
vi.mock("../package.json", () => ({
  default: {
    name: "mabl-mcp-proxy",
    version: "0.1.0",
    description: "Test description",
  },
}));

const logger = pino({ level: "silent" });

const baseConfig = {
  port: 0,
  host: "127.0.0.1",
  logLevel: "silent",
  prettyLogs: false,
  requestTimeoutMs: 5_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300_000,
  mablApiKey: "test-key",
};

function createMockCli() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isRunning: vi.fn(() => true),
    getRestartCount: vi.fn(() => 0),
    getLastMessageAt: vi.fn(() => null),
    send: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  }) as unknown as MablCli;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          parsed = { raw: data };
        }
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: parsed,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("createServer", () => {
  let result: CreateServerResult;
  let cli: MablCli;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    cli = createMockCli();
    result = createServer(baseConfig, logger, cli);
    await new Promise<void>((resolve) => {
      result.server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await result.close();
  });

  it("GET / returns package info", async () => {
    const res = await request(result.server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("mabl-mcp-proxy");
    expect(res.body.version).toBe("0.1.0");
  });

  it("GET /healthz returns CLI status", async () => {
    const res = await request(result.server, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.cli).toEqual(
      expect.objectContaining({ running: true }),
    );
  });

  it("GET /healthz returns unavailable when CLI is not running", async () => {
    (cli.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await request(result.server, "GET", "/healthz");
    expect(res.body.status).toBe("unavailable");
  });

  it("GET /readyz returns 200 when CLI is running", async () => {
    const res = await request(result.server, "GET", "/readyz");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });

  it("GET /readyz returns 503 when CLI is down", async () => {
    (cli.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await request(result.server, "GET", "/readyz");
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
  });

  it("GET /metrics returns prometheus metrics", async () => {
    const res = await request(result.server, "GET", "/metrics");
    expect(res.status).toBe(200);
  });

  it("GET /messages without session returns 400", async () => {
    const res = await request(result.server, "GET", "/messages");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("session");
  });

  it("POST /messages rejects invalid body", async () => {
    const res = await request(result.server, "POST", "/messages", {
      session: "",
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("POST /messages rejects missing body field", async () => {
    const res = await request(result.server, "POST", "/messages", {
      session: "s1",
      body: "not-an-object",
    });
    expect(res.status).toBe(400);
  });

  it("POST /messages forwards valid message to CLI", async () => {
    const res = await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { jsonrpc: "2.0", id: 1, method: "test" },
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(cli.send).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });
  });

  it("POST /messages returns 503 when CLI send fails", async () => {
    (cli.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("process not running"),
    );
    const res = await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { jsonrpc: "2.0", id: 1, method: "test" },
    });
    expect(res.status).toBe(503);
  });

  it("POST /messages accepts notifications (no id)", async () => {
    const res = await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { jsonrpc: "2.0", method: "notify" },
    });
    expect(res.status).toBe(202);
  });

  it("POST /messages rejects invalid body.id type", async () => {
    const res = await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { id: [1, 2], method: "test" },
    });
    expect(res.status).toBe(400);
  });

  it("clears pending requests on CLI exit", async () => {
    await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { jsonrpc: "2.0", id: "req-1", method: "test" },
    });

    (cli as unknown as EventEmitter).emit("exit", { code: 1, signal: null });
  });

  it("times out pending requests", async () => {
    await request(result.server, "POST", "/messages", {
      session: "sess-1",
      body: { jsonrpc: "2.0", id: "req-timeout", method: "test" },
    });

    vi.advanceTimersByTime(5_001);
  });
});
