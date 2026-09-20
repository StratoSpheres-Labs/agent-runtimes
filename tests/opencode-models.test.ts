import { describe, expect, it } from "vitest";
import {
  buildOpencodeArgs,
  mergeOpencodeModelLists,
  parseOpenCodeModels,
  supportsOpencodeVariant,
} from "../runtimes/opencode/definition.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import type { RuntimeModel } from "../src/definition/model.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";

const VERBOSE_SAMPLE = [
  "opencode/claude-fable-5",
  "{",
  '  "id": "claude-fable-5",',
  '  "name": "Claude Fable 5",',
  '  "variants": {',
  '    "low": { "effort": "low" },',
  '    "not a variant": {},',
  '    "medium": { "effort": "medium" }',
  "  }",
  "}",
  "opencode/big-pickle",
  "{",
  '  "id": "big-pickle",',
  '  "name": "Big Pickle",',
  '  "variants": {}',
  "}",
  "bai/deepseek-v4-flash",
  "opencode/claude-fable-5",
  "garbage line here",
  "",
].join("\n");

describe("parseOpenCodeModels", () => {
  it("extracts ids, names, and variant keys from verbose output", () => {
    const out = parseOpenCodeModels(VERBOSE_SAMPLE);
    expect(out?.map((m) => m.id)).toEqual([
      "opencode/claude-fable-5",
      "opencode/big-pickle",
      "bai/deepseek-v4-flash",
    ]);
    const fable = out?.[0];
    expect(fable?.provider).toBe("opencode");
    expect(fable?.name).toBe("Claude Fable 5");
    expect(fable?.reasoningOptions).toEqual([
      { id: "low", label: "low" },
      { id: "medium", label: "medium" },
    ]);
    // Empty variants object → no reasoningOptions key at all.
    expect(out?.[1]).not.toHaveProperty("reasoningOptions");
    // Plain id line without metadata stays valid (custom providers).
    expect(out?.[2]).toMatchObject({ id: "bai/deepseek-v4-flash", provider: "bai" });
  });

  it("degrades truncated JSON to id-only instead of throwing", () => {
    const out = parseOpenCodeModels('opencode/a\n{\n  "id": "a",\n');
    expect(out?.map((m) => m.id)).toEqual(["opencode/a"]);
  });

  it("returns null for empty/garbage output", () => {
    expect(parseOpenCodeModels("")).toBeNull();
    expect(parseOpenCodeModels("nothing here\n")).toBeNull();
  });
});

describe("mergeOpencodeModelLists", () => {
  const verbose: RuntimeModel[] = [
    { id: "opencode/a", provider: "opencode", name: "A", reasoningOptions: [{ id: "low" }] },
  ];
  const plain: RuntimeModel[] = [
    { id: "opencode/a", provider: "opencode", name: "A-plain" },
    { id: "bai/b", provider: "bai", name: "b" },
  ];

  it("unions both sides, verbose wins on conflict", () => {
    expect(mergeOpencodeModelLists(verbose, plain)).toEqual([
      { id: "opencode/a", provider: "opencode", name: "A", reasoningOptions: [{ id: "low" }] },
      { id: "bai/b", provider: "bai", name: "b" },
    ]);
  });

  it("returns null only when both sides are empty", () => {
    expect(mergeOpencodeModelLists(null, [])).toBeNull();
    expect(mergeOpencodeModelLists(null, plain)).toEqual(plain);
    expect(mergeOpencodeModelLists(verbose, [])).toEqual(verbose);
  });
});

describe("supportsOpencodeVariant", () => {
  const known: RuntimeModel[] = [
    { id: "opencode/fable", reasoningOptions: [{ id: "low" }, { id: "medium" }] },
    { id: "opencode/plain" },
  ];

  it("gates known pairs, omits unknown ones", () => {
    expect(supportsOpencodeVariant("opencode/fable", "low", known)).toBe(true);
    expect(supportsOpencodeVariant("opencode/fable", "max", known)).toBe(false);
    expect(supportsOpencodeVariant("opencode/plain", "low", known)).toBe(false);
    expect(supportsOpencodeVariant("opencode/ghost", "low", known)).toBe(false);
    expect(supportsOpencodeVariant("opencode/fable", undefined, known)).toBe(false);
  });

  it("fails open without model context or without a fetched list", () => {
    expect(supportsOpencodeVariant(undefined, "high", known)).toBe(true);
    expect(supportsOpencodeVariant("opencode/fable", "high", null)).toBe(true);
  });
});

describe("buildOpencodeArgs --variant gating", () => {
  const known: RuntimeModel[] = [
    { id: "opencode/fable", reasoningOptions: [{ id: "low" }, { id: "medium" }] },
  ];

  it("emits known pairs, omits unknown ones", () => {
    expect(
      buildOpencodeArgs({ model: "opencode/fable", variant: "low", knownModels: known }),
    ).toContain("--variant");
    const omitted = buildOpencodeArgs({
      model: "opencode/fable",
      variant: "max",
      knownModels: known,
    });
    expect(omitted).not.toContain("--variant");
    const unknownModel = buildOpencodeArgs({
      model: "opencode/ghost",
      variant: "low",
      knownModels: known,
    });
    expect(unknownModel).not.toContain("--variant");
  });

  it("preserves legacy emit without model context (existing callers)", () => {
    expect(buildOpencodeArgs({ reasoning: { effort: "high" } })).toContain("--variant");
  });

  it("rejects hostile variant ids", () => {
    expect(() =>
      buildOpencodeArgs({ model: "opencode/fable", variant: "--dir", knownModels: known }),
    ).toThrow(RuntimeSessionError);
  });
});

describe("OpencodeRuntime.models() (live)", () => {
  it("returns the merged catalog with variant metadata", async () => {
    const rt = new OpencodeRuntime();
    const status = await rt.detect();
    if (!status.installed) return;
    const models = await rt.models();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\//);
    }
    // Verbose path worked: at least one model advertises variants.
    const withVariants = models.find((m) => (m.reasoningOptions ?? []).length > 0);
    expect(withVariants).toBeDefined();
    if (withVariants) {
      const first = withVariants.reasoningOptions?.[0]?.id ?? "";
      // Primed module cache gates consistently with the live list.
      expect(buildOpencodeArgs({ model: withVariants.id, variant: first })).toContain("--variant");
      expect(
        buildOpencodeArgs({ model: withVariants.id, variant: "no-such-variant-xyz" }),
      ).not.toContain("--variant");
    }
  }, 60000);
});
