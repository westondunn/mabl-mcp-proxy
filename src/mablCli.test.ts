import { EventEmitter, Readable, Writable } from "node:stream";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "pino";

import { MablCli } from "./mablCli";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock timers/promises delay
vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
}));

// eslint-disable-next-line import/order -- must follow vi.mock declarations
import { spawn } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);

function createMockChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    killed: false,
    kill: vi.fn(() => {
      (child as unknown as { killed: boolean }).killed = true;
      return true;
    }),
    removeAllListeners: vi.fn(() => child),
  });
  (stdout as unknown as { setEncoding: ReturnType<typeof vi.fn> }).setEncoding =
    vi.fn();
  (stderr as unknown as { setEncoding: ReturnType<typeof vi.fn> }).setEncoding =
    vi.fn();
  return child;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;
(mockLogger.child as ReturnType<typeof vi.fn>).mockReturnValue(mockLogger);

describe("MablCli", () => {
  let authChild: ReturnType<typeof createMockChild>;
  let mpcChild: ReturnType<typeof createMockChild>;

  beforeEach(() => {
    vi.restoreAllMocks();
    (mockLogger.child as ReturnType<typeof vi.fn>).mockReturnValue(mockLogger);
    authChild = createMockChild();
    mpcChild = createMockChild();

    let callCount = 0;
    mockedSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return authChild;
      return mpcChild;
    });
  });

  function completeAuth() {
    process.nextTick(() => authChild.emit("exit", 0, null));
  }

  it("authenticates and spawns CLI on start()", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    completeAuth();
    await cli.start();

    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(mockedSpawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["mabl", "auth", "activate-key", "key"]),
    );
    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(["mcp", "start"]),
    );

    await cli.stop();
  });

  it("throws if start() is called after stop()", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    await cli.stop();
    await expect(cli.start()).rejects.toThrow(
      "Cannot start mabl CLI after shutdown",
    );
  });

  it("reports isRunning() correctly", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    expect(cli.isRunning()).toBe(false);

    completeAuth();
    await cli.start();
    expect(cli.isRunning()).toBe(true);

    await cli.stop();
    expect(cli.isRunning()).toBe(false);
  });

  it("sends JSON to stdin", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    completeAuth();
    await cli.start();

    const writeSpy = vi.spyOn(mpcChild.stdin!, "write");
    await cli.send({ jsonrpc: "2.0", id: 1, method: "test" });
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"jsonrpc":"2.0"'),
    );

    await cli.stop();
  });

  it("throws when sending to a stopped CLI", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    await expect(cli.send({ test: true })).rejects.toThrow(
      "mabl CLI process is not running",
    );
  });

  it("emits parsed JSON messages from stdout", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    completeAuth();
    await cli.start();

    const messagePromise = new Promise<unknown>((resolve) => {
      cli.on("message", resolve);
    });

    mpcChild.stdout!.push('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

    const msg = await messagePromise;
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect(cli.getLastMessageAt()).toBeTypeOf("number");

    await cli.stop();
  });

  it("handles partial stdout lines (buffering)", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    completeAuth();
    await cli.start();

    const messages: unknown[] = [];
    cli.on("message", (m) => messages.push(m));

    mpcChild.stdout!.push('{"jsonrpc":"2.0","id":');
    mpcChild.stdout!.push('1,"result":"ok"}\n');

    await new Promise((r) => process.nextTick(r));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });

    await cli.stop();
  });

  it("handles multiple messages in one chunk", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    completeAuth();
    await cli.start();

    const messages: unknown[] = [];
    cli.on("message", (m) => messages.push(m));

    mpcChild.stdout!.push('{"id":1}\n{"id":2}\n');
    await new Promise((r) => process.nextTick(r));

    expect(messages).toHaveLength(2);

    await cli.stop();
  });

  it("emits exit event when CLI exits unexpectedly", async () => {
    const cli = new MablCli({
      apiKey: "key",
      logger: mockLogger,
      restartDelayMs: 0,
    });
    completeAuth();
    await cli.start();

    const exitPromise = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      cli.on("exit", resolve);
    });

    mpcChild.emit("exit", 1, null);

    const exitInfo = await exitPromise;
    expect(exitInfo.code).toBe(1);

    await cli.stop();
  });

  it("tracks restart count", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    expect(cli.getRestartCount()).toBe(0);
    await cli.stop();
  });

  it("rejects on auth failure", async () => {
    const cli = new MablCli({ apiKey: "key", logger: mockLogger });
    process.nextTick(() => authChild.emit("exit", 1, null));
    await expect(cli.start()).rejects.toThrow(
      "mabl auth activate-key command failed",
    );
  });
});
