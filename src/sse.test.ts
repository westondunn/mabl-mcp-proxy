import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Response } from "express";
import { Logger } from "pino";

import { SseBroker } from "./sse";

// Mock the metrics module to avoid prom-client side effects in tests
vi.mock("./metrics", () => ({
  sseClientsGauge: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;
(mockLogger.child as ReturnType<typeof vi.fn>).mockReturnValue(mockLogger);

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  flushHeaders: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _chunks: string[];
  _headers: Record<string, string>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function createMockResponse(): MockResponse {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    _chunks: chunks,
    _headers: headers,
    _emit(event: string, ...args: unknown[]) {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
  };
}

describe("SseBroker", () => {
  let broker: SseBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new SseBroker(mockLogger, {
      heartbeatIntervalMs: 15_000,
      idleTimeoutMs: 120_000,
    });
  });

  afterEach(() => {
    broker.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("attaches a client and sets SSE headers", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it("sends a ready event on attach", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    expect(res._chunks).toContain("event: ready\n");
    expect(res._chunks.some((c: string) => c.includes('"sess-1"'))).toBe(true);
  });

  it("tracks session IDs", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broker.attach("a", res1 as unknown as Response);
    broker.attach("b", res2 as unknown as Response);

    expect(broker.getSessionIds()).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("sends events to a specific session", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    broker.send("sess-1", "message", { data: "hello" });

    expect(res._chunks).toContain("event: message\n");
    expect(
      res._chunks.some((c: string) => c.includes('"data":"hello"')),
    ).toBe(true);
  });

  it("does not throw when sending to non-existent session", () => {
    expect(() => {
      broker.send("no-such-session", "message", { data: "x" });
    }).not.toThrow();
  });

  it("broadcasts events to all sessions", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broker.attach("a", res1 as unknown as Response);
    broker.attach("b", res2 as unknown as Response);

    broker.broadcast("message", (sessionId) => ({ for: sessionId }));

    expect(res1._chunks.some((c: string) => c.includes('"for":"a"'))).toBe(
      true,
    );
    expect(res2._chunks.some((c: string) => c.includes('"for":"b"'))).toBe(
      true,
    );
  });

  it("replaces existing connection for same session", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    broker.attach("sess-1", res1 as unknown as Response);
    broker.attach("sess-1", res2 as unknown as Response);

    expect(res1.end).toHaveBeenCalled();
    expect(broker.getSessionIds()).toEqual(["sess-1"]);
  });

  it("removes client on response close", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    expect(broker.getSessionIds()).toContain("sess-1");

    res._emit("close");

    expect(broker.getSessionIds()).not.toContain("sess-1");
  });

  it("removes client on response error", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    res._emit("error", new Error("connection reset"));

    expect(broker.getSessionIds()).not.toContain("sess-1");
  });

  it("sends heartbeats on interval", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);
    const initialChunkCount = res._chunks.length;

    vi.advanceTimersByTime(15_000);

    expect(res._chunks.length).toBeGreaterThan(initialChunkCount);
    expect(res._chunks.some((c: string) => c.includes(": heartbeat"))).toBe(
      true,
    );
  });

  it("closes idle connections after idle timeout", () => {
    const res = createMockResponse();
    broker.attach("sess-1", res as unknown as Response);

    // Advance past idle timeout - need to reach next heartbeat after idleTimeoutMs
    // Heartbeats fire every 15s, idle check needs now - lastEventAt > 120s
    // So we need to reach the heartbeat at 135s
    vi.advanceTimersByTime(135_001);

    expect(res.end).toHaveBeenCalled();
    expect(broker.getSessionIds()).not.toContain("sess-1");
  });

  it("close() ends all client connections and clears state", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broker.attach("a", res1 as unknown as Response);
    broker.attach("b", res2 as unknown as Response);

    broker.close();

    expect(res1.end).toHaveBeenCalled();
    expect(res2.end).toHaveBeenCalled();
    expect(broker.getSessionIds()).toEqual([]);
  });
});
