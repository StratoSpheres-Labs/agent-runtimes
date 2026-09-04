import { describe, expect, it } from "vitest";
import { discoverModels } from "../src/discovery/models.js";
import { findExecutable } from "../src/discovery/executable.js";
import { DefaultRuntime } from "../src/core/runtime.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { claudeDefinition } from "../runtimes/claude/definition.js";

describe("discoverModels", () => {
  it("falls back when command not found", async () => {
    const fallback = [{ id: "a/b", provider: "a" }];
    const models = await discoverModels("definitely-not-exist-xyz", ["models"], fallback);
    expect(models).toEqual(fallback);
  });

  it("discovers opencode models live (if installed) or falls back", async () => {
    const fallback = opencodeDefinition.models?.fallbackModels ?? [];
    // Resolve first: bare-name spawn can hit a stale/broken shim whose
    // `models` subcommand hangs (see docs/cross-platform.md §1).
    const exe = await findExecutable("opencode");
    const models = await discoverModels(exe ?? "opencode", ["models"], fallback);
    expect(models.length).toBeGreaterThan(0);
    // Live opencode returns provider/model ids
    const first = models[0];
    expect(first?.id).toContain("/");
  }, 15000);
});

describe("Runtime.models()", () => {
  it("returns fallback when live discovery fails", async () => {
    const rt = new DefaultRuntime({
      ...opencodeDefinition,
      executable: { command: "not-exist-xyz", versionArgs: ["--version"] },
      models: {
        fallbackModels: [{ id: "x/y" }],
        listCommand: ["models"],
      },
    });
    const models = await rt.models();
    expect(models).toEqual([{ id: "x/y" }]);
  });

  it("opencode runtime models() returns list", async () => {
    const rt = new DefaultRuntime(opencodeDefinition);
    const models = await rt.models();
    expect(models.length).toBeGreaterThan(0);
    // Should contain at least the free model from fallback
    expect(models.some((m) => m.id.includes("mimo"))).toBe(true);
  }, 15000);

  it("claude declares no list command (`claude --models` is unknown option)", () => {
    expect(claudeDefinition.models?.listCommand).toBeUndefined();
  });

  it("returns fallback without spawning when no list command is declared", async () => {
    // Guards the `claude models` trap: the default ["models"] would run the
    // agent with "models" as the prompt. No listCommand → no spawn at all.
    const rt = new DefaultRuntime(claudeDefinition);
    await expect(rt.models()).resolves.toEqual(claudeDefinition.models?.fallbackModels ?? []);
  });
});
