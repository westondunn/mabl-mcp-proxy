import fs from "node:fs/promises";

import { describe, it, expect, beforeEach, vi } from "vitest";

import { loadConfig } from "./config";

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);

function setEnv(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    MABL_API_KEY: "test-key-123",
    ALLOW_HTTP: "true",
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    process.env[k] = v;
  }
}

function clearEnv() {
  for (const key of [
    "MABL_API_KEY",
    "PORT",
    "HOST",
    "LOG_LEVEL",
    "PRETTY_LOGS",
    "REQUEST_TIMEOUT_MS",
    "HEARTBEAT_INTERVAL_MS",
    "IDLE_TIMEOUT_MS",
    "TLS_CERT_PATH",
    "TLS_KEY_PATH",
    "TLS_CA_PATH",
    "ALLOW_HTTP",
  ]) {
    delete process.env[key];
  }
}

describe("loadConfig", () => {
  beforeEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("throws when MABL_API_KEY is missing", async () => {
    await expect(loadConfig()).rejects.toThrow("MABL_API_KEY is required");
  });

  it("returns defaults with minimal env", async () => {
    setEnv();
    const config = await loadConfig();

    expect(config.mablApiKey).toBe("test-key-123");
    expect(config.port).toBe(443);
    expect(config.host).toBe("0.0.0.0");
    expect(config.logLevel).toBe("info");
    expect(config.prettyLogs).toBe(false);
    expect(config.requestTimeoutMs).toBe(45_000);
    expect(config.heartbeatIntervalMs).toBe(15_000);
    expect(config.idleTimeoutMs).toBe(120_000);
    expect(config.tls).toBeUndefined();
  });

  it("parses numeric environment variables", async () => {
    setEnv({
      PORT: "8080",
      REQUEST_TIMEOUT_MS: "30000",
      HEARTBEAT_INTERVAL_MS: "5000",
      IDLE_TIMEOUT_MS: "60000",
    });
    const config = await loadConfig();

    expect(config.port).toBe(8080);
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.heartbeatIntervalMs).toBe(5_000);
    expect(config.idleTimeoutMs).toBe(60_000);
  });

  it("falls back to defaults for non-numeric values", async () => {
    setEnv({ PORT: "not-a-number" });
    const config = await loadConfig();
    expect(config.port).toBe(443);
  });

  it("reads TLS files when paths are set", async () => {
    clearEnv();
    process.env.MABL_API_KEY = "test-key-123";
    process.env.TLS_CERT_PATH = "/certs/cert.pem";
    process.env.TLS_KEY_PATH = "/certs/key.pem";
    process.env.TLS_CA_PATH = "/certs/ca.pem";

    mockedFs.readFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === "/certs/cert.pem") return "CERT_DATA";
      if (p === "/certs/key.pem") return "KEY_DATA";
      if (p === "/certs/ca.pem") return "CA_DATA";
      throw new Error("unexpected path");
    });

    const config = await loadConfig();
    expect(config.tls).toEqual({
      cert: "CERT_DATA",
      key: "KEY_DATA",
      ca: "CA_DATA",
    });
  });

  it("throws when TLS is incomplete and ALLOW_HTTP is not set", async () => {
    clearEnv();
    process.env.MABL_API_KEY = "test-key-123";

    await expect(loadConfig()).rejects.toThrow(
      "TLS_CERT_PATH and TLS_KEY_PATH must be set",
    );
  });

  it("parses PRETTY_LOGS=true", async () => {
    setEnv({ PRETTY_LOGS: "true" });
    const config = await loadConfig();
    expect(config.prettyLogs).toBe(true);
  });

  it("parses custom HOST and LOG_LEVEL", async () => {
    setEnv({ HOST: "127.0.0.1", LOG_LEVEL: "debug" });
    const config = await loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.logLevel).toBe("debug");
  });
});
