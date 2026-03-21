import { describe, it, expect, afterEach } from "vitest";

import { createLogger } from "./logger";

describe("createLogger", () => {
  const origIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: origIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("returns a pino logger with the specified level", () => {
    const logger = createLogger({ level: "warn", pretty: false });
    expect(logger.level).toBe("warn");
  });

  it("returns a structured logger when pretty is false", () => {
    const logger = createLogger({ level: "info", pretty: false });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });

  it("returns a structured logger when pretty is true but not TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    const logger = createLogger({ level: "info", pretty: true });
    expect(logger.level).toBe("info");
  });
});
