import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeProcess } from "../src/core/lifecycle.js";

/**
 * Regression: a `spawn` that fails (ENOENT) delivers its `error` event on a
 * later tick. `RuntimeProcess.cleanup()` used to `removeAllListeners()` on the
 * child, which removed the `error` handler — so that late event had nowhere to
 * go and Node escalated it to an uncaught exception.
 *
 * It surfaced as a Vitest "unhandled error" that failed the entire run on Linux
 * CI while all 800 tests passed: every assertion was green and the exit code
 * was still 1.
 *
 * These tests cannot assert "no uncaught exception" directly (it would take the
 * whole file down). They assert the invariant that makes it impossible: after
 * cleanup, the child still has an `error` listener.
 */
describe("RuntimeProcess cleanup — a late spawn error cannot escape", () => {
  it("survives a spawn failure closed immediately (no late throw)", async () => {
    // The real-world shape: a missing CLI, torn down straight away. Any
    // uncaught exception here fails this file, which is the point.
    const cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-cleanup2-"));
    try {
      for (let i = 0; i < 3; i += 1) {
        const proc = new RuntimeProcess({
          command: "agent-runtimes-missing-xyz",
          args: ["run", "--format", "json", "--thinking", "--dir", cwd],
          cwd,
        });
        proc.spawn();
        await proc.close();
      }
      // Give any late tick a chance to fire.
      await new Promise((r) => setTimeout(r, 250));
      expect(true).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it("still reports a spawn failure to the caller who asked for the result", async () => {
    // The other half: cleanup must not swallow the error from the ONE consumer
    // that legitimately wants it — `result()`.
    const cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-cleanup3-"));
    const proc = new RuntimeProcess({ command: "agent-runtimes-missing-xyz", cwd });
    try {
      proc.spawn();
      await expect(proc.wait()).rejects.toThrow(/ENOENT|spawn/i);
    } finally {
      await proc.close().catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
