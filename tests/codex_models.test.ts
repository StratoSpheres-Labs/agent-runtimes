import { describe, expect, it } from "vitest";
import { parseCodexDebugModels } from "../runtimes/codex/definition.js";

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
