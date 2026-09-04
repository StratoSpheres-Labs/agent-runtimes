import { describe, expect, it } from "vitest";
import { runtimes } from "../src/runtimes.js";
import { RuntimeRegistry } from "../src/core/registry.js";
import { DefaultRuntime } from "../src/core/runtime.js";
import { RuntimeNotFoundError } from "../src/core/errors.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import { ClaudeRuntime } from "../runtimes/claude/runtime.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";

describe("runtimes facade (Phase 18)", () => {
  it("lists the three preregistered adapters", () => {
    expect(runtimes.list()).toEqual(["opencode", "claude", "codex", "opencode-acp"]);
  });

  it("resolve returns the real adapter class, not a stub", async () => {
    await expect(runtimes.resolve("opencode")).resolves.toBeInstanceOf(OpencodeRuntime);
    await expect(runtimes.resolve("claude")).resolves.toBeInstanceOf(ClaudeRuntime);
    await expect(runtimes.resolve("codex")).resolves.toBeInstanceOf(CodexRuntime);
  });

  it("throws RuntimeNotFoundError for unknown id", async () => {
    await expect(runtimes.resolve("nope")).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });

  it("detectAll returns a valid status per adapter", async () => {
    const results = await runtimes.detectAll();
    expect(results.map((r) => r.id).sort()).toEqual([
      "claude",
      "codex",
      "opencode",
      "opencode-acp",
    ]);
    for (const { status } of results) {
      if (status.installed) {
        expect(typeof status.executable).toBe("string");
        expect(status.version === null || typeof status.version === "string").toBe(true);
      } else {
        expect(status).toEqual({ installed: false });
      }
    }
    // Three parallel live detects; slow under full-suite load (cf. models.test.ts).
  }, 15000);

  it("register without factory still falls back to DefaultRuntime", async () => {
    const registry = new RuntimeRegistry();
    registry.register(opencodeDefinition);
    const runtime = await registry.resolve("opencode");
    expect(runtime).toBeInstanceOf(DefaultRuntime);
    expect(runtime).not.toBeInstanceOf(OpencodeRuntime);
  });
});
