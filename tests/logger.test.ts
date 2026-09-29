import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultSession } from "../src/core/session.js";
import { consoleLogger, silentLogger, type RuntimeLogger } from "../src/index.js";

function capturingLogger(): { logger: RuntimeLogger; entries: Array<[string, unknown[]]> } {
  const entries: Array<[string, unknown[]]> = [];
  const logger: RuntimeLogger = {
    debug: (...args: unknown[]): void => {
      entries.push(["debug", args]);
    },
    info: (...args: unknown[]): void => {
      entries.push(["info", args]);
    },
    warn: (...args: unknown[]): void => {
      entries.push(["warn", args]);
    },
    error: (...args: unknown[]): void => {
      entries.push(["error", args]);
    },
  };
  return { logger, entries };
}

describe("logger", () => {
  it("silentLogger drops everything without throwing", () => {
    expect(() => {
      silentLogger.debug("a", { b: 1 });
      silentLogger.info("a");
      silentLogger.warn("a");
      silentLogger.error("a");
    }).not.toThrow();
  });

  it("consoleLogger forwards with a prefix", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const log = consoleLogger("test-prefix");
      log.debug("hello");
      log.warn("oops", { n: 2 });
      expect(debug).toHaveBeenCalledWith("[test-prefix]", "hello");
      expect(warn).toHaveBeenCalledWith("[test-prefix]", "oops", { n: 2 });
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });

  it("sessions forward the logger to lifecycle notes (spawn/exit)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "logger-"));
    try {
      const { logger, entries } = capturingLogger();
      const session = new DefaultSession({ cwd, logger });
      const run = await session.run("hi");
      for await (const e of run.events()) {
        if (e.type === "done") break;
      }
      await session.close();
      const kinds = entries.map(([k, args]) => {
        const first = typeof args[0] === "string" ? args[0] : "";
        return `${k}:${first}`;
      });
      expect(kinds).toContain("debug:spawn");
      expect(kinds).toContain("debug:exit");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("without a logger nothing is captured and turns still work", async () => {
    const session = new DefaultSession();
    const run = await session.run("hi");
    let last = "";
    for await (const e of run.events()) {
      last = e.type;
      if (e.type === "done") break;
    }
    expect(last).toBe("done");
    await session.close();
  });
});
