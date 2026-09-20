import { describe, expect, it } from "vitest";
import { parseCodexDebugModels } from "../runtimes/codex/definition.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import type { RuntimeStatus } from "../src/core/runtime.js";

describe("parseCodexDebugModels", () => {
  it("parses slug/display_name, skips hidden and dupes", () => {
    const out = parseCodexDebugModels(
      JSON.stringify({
        models: [
          { slug: "gpt-5", display_name: "GPT-5" },
          { slug: "o4-mini", name: "o4 Mini" },
          { slug: "hidden-x", visibility: "hidden" },
          { slug: "gpt-5", display_name: "dup" },
          "junk",
          {},
        ],
      }),
    );
    expect(out).toEqual([
      { id: "gpt-5", name: "GPT-5", provider: "openai" },
      { id: "o4-mini", name: "o4 Mini", provider: "openai" },
    ]);
  });

  it("accepts a bare array shape", () => {
    expect(parseCodexDebugModels(JSON.stringify([{ id: "o3" }]))).toEqual([
      { id: "o3", name: "o3", provider: "openai" },
    ]);
  });

  it("returns null for non-model output", () => {
    expect(parseCodexDebugModels("not json")).toBeNull();
    expect(parseCodexDebugModels(JSON.stringify({ models: [] }))).toBeNull();
    expect(parseCodexDebugModels(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});

describe("CodexRuntime detect()/models() (live)", () => {
  it("detects version through the shim and lists live models when installed", async () => {
    // Regression: win32 npm `.cmd` shims fail with EINVAL when spawned
    // directly — version/models probes must use the host-node launch.
    const rt = new CodexRuntime();
    const status = await rt.detect();
    if (!status.installed) return;
    expect(status.version).toMatch(/codex-cli/);
    const models = await rt.models();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id.trim().length).toBeGreaterThan(0);
    }
  }, 30000);

  it("returns [] (unknown) instead of a stale list when the CLI is missing", async () => {
    class BrokenCodexRuntime extends CodexRuntime {
      public override detect(): Promise<RuntimeStatus> {
        return Promise.resolve({
          installed: true,
          executable: "definitely-not-exist-xyz",
          version: null,
        });
      }
    }
    await expect(new BrokenCodexRuntime().models()).resolves.toEqual([]);
  });
});
