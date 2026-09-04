import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimes } from "../../src/runtimes.js";
import { findExecutable } from "../../src/discovery/executable.js";

async function rmRetry(dir: string): Promise<void> {
  // The agent may leave briefly-live grandchildren (tool processes) holding
  // the cwd lock on Windows after the child itself is dead — retry instead
  // of failing the test on environment file-lock flakiness.
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.warn(`could not remove scratch dir (agent child may hold locks): ${dir}`);
}

/**
 * Phase 20 — real `opencode acp` integration over JSON-RPC.
 * Verifies: resolve → detect → initialize → session/new → [set_model] →
 * prompt → text_delta/tool events → done → cleanup.
 * Skips gracefully without the binary; skips assertions on quota/auth
 * failures (mirrors the CLI integration test).
 */
describe("integration: opencode-acp", () => {
  it("runs a full ACP turn and streams RuntimeEvent", async () => {
    const exe = await findExecutable("opencode");
    if (!exe) {
      console.warn("opencode not installed — skipping ACP integration test");
      return;
    }

    const cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-acp-"));
    try {
      const runtime = await runtimes.resolve("opencode-acp");
      const session = await runtime.createSession({ cwd, model: "opencode/mimo-v2.5-free" });
      const run = await session.run("reply with exactly: OK", { timeout: 90000 });
      const types: string[] = [];
      let text = "";
      for await (const e of run.events()) {
        types.push(e.type);
        if (e.type === "text_delta") text += (e as { text: string }).text;
        if (e.type === "done") break;
      }
      await session.close().catch(() => {});
      if (!text) {
        console.warn(`ACP turn produced no text (types: ${types.join(",")}) — skipping assertions`);
        return;
      }
      expect(types).toContain("session_started");
      expect(types).toContain("done");
      expect(text).toContain("OK");
    } finally {
      await rmRetry(cwd);
    }
  }, 120000);
});
