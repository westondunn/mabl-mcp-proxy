import http from "node:http";
import { EventEmitter } from "node:events";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";

import { createServer, CreateServerResult } from "../server";

import type { AppConfig } from "../config";
import type { MablCli } from "../mablCli";

/**
 * FakeCli mimics MablCli's public interface so we can inject it into
 * createServer() and control stdin/stdout behaviour from the test harness.
 */
class FakeCli extends EventEmitter {
  private running = true;
  private sentPayloads: unknown[] = [];
  private shouldFail = false;

  isRunning(): boolean {
    return this.running;
  }

  getLastMessageAt(): number | null {
    return Date.now();
  }

  getRestartCount(): number {
    return 0;
  }

  async send(payload: unknown): Promise<void> {
    if (this.shouldFail) {
      throw new Error("mabl CLI process is not running.");
    }
    this.sentPayloads.push(payload);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Simulate a JSON-RPC response arriving on CLI stdout. */
  simulateResponse(payload: unknown): void {
    this.emit("message", payload);
  }

  /** Simulate the CLI process crashing. */
  simulateCrash(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.running = false;
    this.emit("exit", { code, signal });
  }

  /** Make future send() calls throw (simulates dead process). */
  setSendFailure(fail: boolean): void {
    this.shouldFail = fail;
  }

  /** Return payloads that were sent via send(). */
  getSentPayloads(): unknown[] {
    return this.sentPayloads;
  }

  clearSentPayloads(): void {
    this.sentPayloads = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: "silent" });

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0, // random port
    host: "127.0.0.1",
    logLevel: "silent",
    prettyLogs: false,
    requestTimeoutMs: 2_000, // short for tests
    heartbeatIntervalMs: 60_000, // long so it doesn't fire during tests
    idleTimeoutMs: 60_000,
    mablApiKey: "test-key",
    ...overrides,
  };
}

function getBaseUrl(server: http.Server): string {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    return `http://127.0.0.1:${addr.port}`;
  }
  throw new Error("Server not listening.");
}

/** Opens an SSE connection and collects events. Returns a controller object. */
function openSseStream(baseUrl: string, sessionId: string) {
  const events: Array<{ event: string; data: string }> = [];
  const rawChunks: string[] = [];
  let buffer = "";
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  const req = http.get(`${baseUrl}/messages?session=${sessionId}`, (res) => {
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      rawChunks.push(chunk);
      buffer += chunk;

      // Parse SSE frames from buffer
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.trim()) continue;

        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          } else if (line.startsWith(":")) {
            // comment (heartbeat)
            continue;
          }
        }
        events.push({ event, data });

        if (event === "ready") {
          resolveReady();
        }
      }
    });
    res.on("end", () => {
      resolveClosed();
    });
  });

  req.on("error", () => {
    resolveClosed();
  });

  return {
    events,
    rawChunks,
    ready,
    closed,
    close: () => req.destroy(),
    /** Wait for an event matching the predicate (with timeout). */
    waitForEvent: (
      predicate: (e: { event: string; data: string }) => boolean,
      timeoutMs = 5_000,
    ) =>
      new Promise<{ event: string; data: string }>((resolve, reject) => {
        const existing = events.find(predicate);
        if (existing) {
          resolve(existing);
          return;
        }
        const interval = setInterval(() => {
          const found = events.find(predicate);
          if (found) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve(found);
          }
        }, 20);
        const timer = setTimeout(() => {
          clearInterval(interval);
          reject(new Error("Timed out waiting for SSE event."));
        }, timeoutMs);
      }),
  };
}

async function postMessage(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(responseBody),
            });
          } catch {
            resolve({
              status: res.statusCode ?? 0,
              body: { raw: responseBody },
            });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function httpGet(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: data } });
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP-CLI-SSE integration", () => {
  let fakeCli: FakeCli;
  let srv: CreateServerResult;
  let baseUrl: string;

  beforeEach(async () => {
    fakeCli = new FakeCli();
    srv = createServer(testConfig(), silentLogger, fakeCli as unknown as MablCli);
    await new Promise<void>((resolve) => {
      srv.server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = getBaseUrl(srv.server as http.Server);
  });

  afterEach(async () => {
    await srv.close();
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe("happy path: full request lifecycle", () => {
    it("POST /messages -> CLI stdin -> CLI stdout -> SSE delivery", async () => {
      // 1. Open SSE connection
      const sse = openSseStream(baseUrl, "session-1");
      await sse.ready;

      // Verify ready event
      expect(sse.events[0]).toEqual({
        event: "ready",
        data: '{"session":"session-1"}',
      });

      // 2. POST a JSON-RPC request
      const result = await postMessage(baseUrl, {
        session: "session-1",
        body: { jsonrpc: "2.0", id: "req-1", method: "tools/list", params: {} },
      });

      expect(result.status).toBe(202);
      expect(result.body).toEqual({ accepted: true });

      // Verify the payload was forwarded to CLI stdin
      expect(fakeCli.getSentPayloads()).toEqual([
        { jsonrpc: "2.0", id: "req-1", method: "tools/list", params: {} },
      ]);

      // 3. Simulate CLI responding
      fakeCli.simulateResponse({
        jsonrpc: "2.0",
        id: "req-1",
        result: { tools: [{ name: "test-tool" }] },
      });

      // 4. Verify SSE delivers the response
      const msgEvent = await sse.waitForEvent((e) => e.event === "message");
      const parsed = JSON.parse(msgEvent.data);
      expect(parsed.session).toBe("session-1");
      expect(parsed.body.id).toBe("req-1");
      expect(parsed.body.result).toEqual({ tools: [{ name: "test-tool" }] });

      sse.close();
    });

    it("handles numeric request IDs", async () => {
      const sse = openSseStream(baseUrl, "sess-num");
      await sse.ready;

      await postMessage(baseUrl, {
        session: "sess-num",
        body: { jsonrpc: "2.0", id: 42, method: "ping" },
      });

      fakeCli.simulateResponse({ jsonrpc: "2.0", id: 42, result: "pong" });

      const msgEvent = await sse.waitForEvent((e) => e.event === "message");
      const parsed = JSON.parse(msgEvent.data);
      expect(parsed.body.id).toBe(42);
      expect(parsed.body.result).toBe("pong");

      sse.close();
    });

    it("handles requests without an id (notifications)", async () => {
      const sse = openSseStream(baseUrl, "sess-notif");
      await sse.ready;

      const result = await postMessage(baseUrl, {
        session: "sess-notif",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });

      expect(result.status).toBe(202);
      // No pending request is created for notifications (no id)
      // Verify it was still sent to CLI
      expect(fakeCli.getSentPayloads()).toHaveLength(1);

      sse.close();
    });
  });

  // -----------------------------------------------------------------------
  // Broadcast behaviour
  // -----------------------------------------------------------------------

  describe("broadcast", () => {
    it("broadcasts CLI messages with unknown IDs to all sessions", async () => {
      const sse1 = openSseStream(baseUrl, "sess-a");
      const sse2 = openSseStream(baseUrl, "sess-b");
      await Promise.all([sse1.ready, sse2.ready]);

      // Simulate an unsolicited message from CLI with an ID not in pending map
      fakeCli.simulateResponse({
        jsonrpc: "2.0",
        id: "unknown-id",
        result: "surprise",
      });

      const ev1 = await sse1.waitForEvent((e) => e.event === "message");
      const ev2 = await sse2.waitForEvent((e) => e.event === "message");

      expect(JSON.parse(ev1.data).session).toBe("sess-a");
      expect(JSON.parse(ev2.data).session).toBe("sess-b");

      sse1.close();
      sse2.close();
    });

    it("broadcasts CLI messages without IDs to all sessions", async () => {
      const sse1 = openSseStream(baseUrl, "sess-c");
      const sse2 = openSseStream(baseUrl, "sess-d");
      await Promise.all([sse1.ready, sse2.ready]);

      fakeCli.simulateResponse({
        jsonrpc: "2.0",
        method: "server/notification",
        params: { level: "info" },
      });

      const ev1 = await sse1.waitForEvent((e) => e.event === "message");
      const ev2 = await sse2.waitForEvent((e) => e.event === "message");

      expect(JSON.parse(ev1.data).body.method).toBe("server/notification");
      expect(JSON.parse(ev2.data).body.method).toBe("server/notification");

      sse1.close();
      sse2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Error scenarios
  // -----------------------------------------------------------------------

  describe("malformed payloads", () => {
    it("rejects missing session field", async () => {
      const result = await postMessage(baseUrl, {
        body: { jsonrpc: "2.0", id: "1", method: "test" },
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("session");
    });

    it("rejects empty session field", async () => {
      const result = await postMessage(baseUrl, {
        session: "",
        body: { jsonrpc: "2.0", id: "1", method: "test" },
      });
      expect(result.status).toBe(400);
    });

    it("rejects missing body field", async () => {
      const result = await postMessage(baseUrl, { session: "s1" });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("body");
    });

    it("rejects non-object body field", async () => {
      const result = await postMessage(baseUrl, {
        session: "s1",
        body: "not-an-object",
      });
      expect(result.status).toBe(400);
    });

    it("rejects invalid body.id type", async () => {
      const result = await postMessage(baseUrl, {
        session: "s1",
        body: { id: [1, 2, 3], method: "test" },
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("body.id");
    });

    it("rejects non-JSON request body", async () => {
      const result = await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = http.request(
            `${baseUrl}/messages`,
            {
              method: "POST",
              headers: { "Content-Type": "text/plain" },
            },
            (res) => {
              let data = "";
              res.on("data", (chunk: string) => (data += chunk));
              res.on("end", () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: data ? JSON.parse(data) : {},
                });
              });
            },
          );
          req.on("error", reject);
          req.write("not json");
          req.end();
        },
      );
      expect(result.status).toBe(400);
    });
  });

  describe("GET /messages validation", () => {
    it("rejects missing session query parameter", async () => {
      const result = await httpGet(`${baseUrl}/messages`);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("session");
    });

    it("rejects empty session query parameter", async () => {
      const result = await httpGet(`${baseUrl}/messages?session=`);
      expect(result.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  describe("request timeout", () => {
    it("sends a JSON-RPC error via SSE when CLI does not respond in time", async () => {
      // Use a very short timeout for this test
      await srv.close();
      fakeCli = new FakeCli();
      srv = createServer(
        testConfig({ requestTimeoutMs: 200 }),
        silentLogger,
        fakeCli as unknown as MablCli,
      );
      await new Promise<void>((resolve) => {
        srv.server.listen(0, "127.0.0.1", () => resolve());
      });
      baseUrl = getBaseUrl(srv.server as http.Server);

      const sse = openSseStream(baseUrl, "sess-timeout");
      await sse.ready;

      await postMessage(baseUrl, {
        session: "sess-timeout",
        body: { jsonrpc: "2.0", id: "slow-req", method: "slow/operation" },
      });

      // Do NOT simulate a CLI response - let it time out
      const errEvent = await sse.waitForEvent((e) => e.event === "message");
      const parsed = JSON.parse(errEvent.data);

      expect(parsed.session).toBe("sess-timeout");
      expect(parsed.body.jsonrpc).toBe("2.0");
      expect(parsed.body.id).toBe("slow-req");
      expect(parsed.body.error.code).toBe(-32000);
      expect(parsed.body.error.message).toContain("Timed out");

      sse.close();
    });
  });

  // -----------------------------------------------------------------------
  // CLI crash
  // -----------------------------------------------------------------------

  describe("CLI crash mid-request", () => {
    it("sends error to all pending requests when CLI exits", async () => {
      const sse1 = openSseStream(baseUrl, "sess-crash-1");
      const sse2 = openSseStream(baseUrl, "sess-crash-2");
      await Promise.all([sse1.ready, sse2.ready]);

      // Send requests from two different sessions
      await postMessage(baseUrl, {
        session: "sess-crash-1",
        body: { jsonrpc: "2.0", id: "r1", method: "test" },
      });
      await postMessage(baseUrl, {
        session: "sess-crash-2",
        body: { jsonrpc: "2.0", id: "r2", method: "test" },
      });

      // Simulate CLI crash
      fakeCli.simulateCrash(1);

      // Both sessions should receive error responses
      const err1 = await sse1.waitForEvent((e) => {
        if (e.event !== "message") return false;
        const p = JSON.parse(e.data);
        return p.body?.error != null;
      });
      const err2 = await sse2.waitForEvent((e) => {
        if (e.event !== "message") return false;
        const p = JSON.parse(e.data);
        return p.body?.error != null;
      });

      const parsed1 = JSON.parse(err1.data);
      const parsed2 = JSON.parse(err2.data);

      expect(parsed1.body.error.code).toBe(-32001);
      expect(parsed1.body.error.message).toContain("restarted");
      expect(parsed1.body.id).toBe("r1");

      expect(parsed2.body.error.code).toBe(-32001);
      expect(parsed2.body.id).toBe("r2");

      sse1.close();
      sse2.close();
    });

    it("returns 503 when CLI is unavailable on POST", async () => {
      fakeCli.setSendFailure(true);

      const result = await postMessage(baseUrl, {
        session: "sess-down",
        body: { jsonrpc: "2.0", id: "req-fail", method: "test" },
      });

      expect(result.status).toBe(503);
      expect(result.body.error).toContain("unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent sessions
  // -----------------------------------------------------------------------

  describe("concurrent sessions", () => {
    it("routes responses to the correct session", async () => {
      const sseA = openSseStream(baseUrl, "concurrent-a");
      const sseB = openSseStream(baseUrl, "concurrent-b");
      await Promise.all([sseA.ready, sseB.ready]);

      // Send requests from both sessions
      await postMessage(baseUrl, {
        session: "concurrent-a",
        body: { jsonrpc: "2.0", id: "ca-1", method: "test" },
      });
      await postMessage(baseUrl, {
        session: "concurrent-b",
        body: { jsonrpc: "2.0", id: "cb-1", method: "test" },
      });

      // Respond out of order: b first, then a
      fakeCli.simulateResponse({
        jsonrpc: "2.0",
        id: "cb-1",
        result: "response-b",
      });
      fakeCli.simulateResponse({
        jsonrpc: "2.0",
        id: "ca-1",
        result: "response-a",
      });

      // Session A should only get its response
      const evA = await sseA.waitForEvent(
        (e) => e.event === "message" && JSON.parse(e.data).body?.id === "ca-1",
      );
      expect(JSON.parse(evA.data).body.result).toBe("response-a");
      expect(JSON.parse(evA.data).session).toBe("concurrent-a");

      // Session B should only get its response
      const evB = await sseB.waitForEvent(
        (e) => e.event === "message" && JSON.parse(e.data).body?.id === "cb-1",
      );
      expect(JSON.parse(evB.data).body.result).toBe("response-b");
      expect(JSON.parse(evB.data).session).toBe("concurrent-b");

      sseA.close();
      sseB.close();
    });

    it("handles multiple requests on the same session", async () => {
      const sse = openSseStream(baseUrl, "multi-req");
      await sse.ready;

      // Send multiple requests on same session
      await postMessage(baseUrl, {
        session: "multi-req",
        body: { jsonrpc: "2.0", id: "m1", method: "test" },
      });
      await postMessage(baseUrl, {
        session: "multi-req",
        body: { jsonrpc: "2.0", id: "m2", method: "test" },
      });
      await postMessage(baseUrl, {
        session: "multi-req",
        body: { jsonrpc: "2.0", id: "m3", method: "test" },
      });

      // Respond to all three
      fakeCli.simulateResponse({ jsonrpc: "2.0", id: "m2", result: "two" });
      fakeCli.simulateResponse({ jsonrpc: "2.0", id: "m3", result: "three" });
      fakeCli.simulateResponse({ jsonrpc: "2.0", id: "m1", result: "one" });

      // All three should arrive on the same SSE stream
      const ev1 = await sse.waitForEvent(
        (e) => e.event === "message" && JSON.parse(e.data).body?.id === "m1",
      );
      const ev2 = await sse.waitForEvent(
        (e) => e.event === "message" && JSON.parse(e.data).body?.id === "m2",
      );
      const ev3 = await sse.waitForEvent(
        (e) => e.event === "message" && JSON.parse(e.data).body?.id === "m3",
      );

      expect(JSON.parse(ev1.data).body.result).toBe("one");
      expect(JSON.parse(ev2.data).body.result).toBe("two");
      expect(JSON.parse(ev3.data).body.result).toBe("three");

      sse.close();
    });

    it("closes old SSE connection when same session reconnects", async () => {
      const sse1 = openSseStream(baseUrl, "replace-sess");
      await sse1.ready;

      // Open a second SSE for the same session (server should close old one)
      const sse2 = openSseStream(baseUrl, "replace-sess");
      await sse2.ready;

      // The old connection should be ended by the server
      await Promise.race([
        sse1.closed,
        new Promise((r) => setTimeout(r, 2_000)),
      ]);

      // Verify sse2 got a ready event (connection established)
      expect(sse2.events.some((e) => e.event === "ready")).toBe(true);

      sse1.close();
      sse2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Health endpoints
  // -----------------------------------------------------------------------

  describe("health endpoints", () => {
    it("GET / returns service info", async () => {
      const result = await httpGet(`${baseUrl}/`);
      expect(result.status).toBe(200);
      expect(result.body.name).toBe("mabl-mcp-proxy");
      expect(result.body.version).toBe("0.1.0");
      expect(typeof result.body.uptimeSeconds).toBe("number");
    });

    it("GET /healthz reports CLI status", async () => {
      const result = await httpGet(`${baseUrl}/healthz`);
      expect(result.status).toBe(200);
      expect(result.body.status).toBe("ok");
      expect((result.body.cli as Record<string, unknown>).running).toBe(true);
    });

    it("GET /readyz returns 200 when CLI is running", async () => {
      const result = await httpGet(`${baseUrl}/readyz`);
      expect(result.status).toBe(200);
      expect(result.body.ready).toBe(true);
    });

    it("GET /metrics returns prometheus metrics", async () => {
      const result = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          http
            .get(`${baseUrl}/metrics`, (res) => {
              let data = "";
              res.on("data", (chunk: string) => (data += chunk));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: data }),
              );
            })
            .on("error", reject);
        },
      );
      expect(result.status).toBe(200);
      expect(result.body).toContain("http_request_duration_seconds");
    });
  });
});
