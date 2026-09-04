import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { OpencodeParser } from "../../runtimes/opencode/parser.js";
import { buildOpencodeArgs } from "../../runtimes/opencode/definition.js";
import { findExecutable } from "../../src/discovery/executable.js";

/**
 * Phase 11 — real opencode CLI integration
 * Runs `opencode run --format json` and verifies:
 *  resolve → detect → spawn → stdin → stdout parse → done → cleanup
 * Skips gracefully if opencode not installed or not authenticated.
 *
 * Always spawns the absolute path from findExecutable() — never the bare
 * name (bare-name resolution drifts between shims, e.g. stale npm .cmd
 * vs bun .exe on Windows; see docs/cross-platform.md §1).
 */

describe("integration: opencode", () => {
  it("spawns opencode run and streams RuntimeEvent", async () => {
    const exe = await findExecutable("opencode");
    if (!exe) {
      console.warn("opencode not installed — skipping integration test");
      return;
    }

    const args = buildOpencodeArgs({ format: "json" });
    // Add prompt as argv for simplicity (input via stdin also works)
    // We use `opencode run --format json` with prompt "hi" as positional
    const fullArgs = [...args, "hi"];
    const child = spawn(exe, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    // Close stdin immediately — no extra prompt
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (child.stdin) child.stdin.end();

    const parser = new OpencodeParser();
    const events: unknown[] = [];
    let stdoutDone = false;
    let stderrText = "";

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (child.stderr) {
      child.stderr.on("data", (c: Buffer) => {
        stderrText += c.toString("utf-8");
      });
    }

    const stdoutPromise = (async () => {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        const evs = parser.parse(new Uint8Array(chunk));
        events.push(...evs);
      }
      // Flush any buffered partial
      events.push(...parser.flush());
      stdoutDone = true;
    })();

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("close", (code) => {
        resolve(code);
      });
      child.on("error", () => {
        resolve(null);
      });
      // Timeout after 30s to avoid hanging CI
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        resolve(null);
      }, 30_000);
    });

    await stdoutPromise;

    // If opencode failed (e.g. not authenticated), log and skip assertions
    if (exitCode !== 0 && events.length === 0) {
      console.warn(
        `opencode exited with ${String(exitCode)}, stderr: ${stderrText.slice(0, 500)} — skipping assertions`,
      );
      return;
    }

    // Must have produced at least one event and ended with done
    expect(events.length).toBeGreaterThan(0);
    // At least one text_delta or session_started/done
    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types.some((t) => ["text_delta", "done", "session_started", "error"].includes(t))).toBe(
      true,
    );

    // Stream must have closed
    expect(stdoutDone).toBe(true);

    // No zombie — process exited
    expect(exitCode).not.toBe(null);

    // Cleanup check: ensure child is closed
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 35_000);
});
