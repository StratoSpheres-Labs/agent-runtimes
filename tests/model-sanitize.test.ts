import { describe, expect, it } from "vitest";
import { sanitizeModelId } from "../src/definition/model.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import { buildOpencodeArgs } from "../runtimes/opencode/definition.js";
import { buildClaudeArgs } from "../runtimes/claude/definition.js";
import { buildCodexArgs } from "../runtimes/codex/definition.js";

describe("sanitizeModelId", () => {
  it("accepts aliases, versions, and provider/model ids", () => {
    for (const id of [
      "sonnet",
      "o4-mini",
      "gpt-5.4-mini",
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-5",
      "opencode/mimo-v2.5-free",
      "provider/model@tag",
      "a",
      "x".repeat(200),
    ]) {
      expect(sanitizeModelId(id)).toBe(id);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeModelId("  sonnet  ")).toBe("sonnet");
  });

  it("rejects empty, flag-shaped, and hostile ids", () => {
    for (const id of [
      "",
      "   ",
      "--dangerously-skip-permissions",
      "-m",
      "--model=x",
      "gpt 5",
      "a\tb",
      "a\nb",
      ";rm -rf",
      "$(x)",
      "x".repeat(201),
    ]) {
      expect(sanitizeModelId(id)).toBeNull();
    }
    expect(sanitizeModelId(null)).toBeNull();
    expect(sanitizeModelId(undefined)).toBeNull();
  });
});

describe("buildArgs reject hostile model ids", () => {
  const builders = [buildOpencodeArgs, buildClaudeArgs, buildCodexArgs] as const;
  for (const build of builders) {
    it(`${build.name} throws RuntimeSessionError on flag-shaped model`, () => {
      expect(() => build({ model: "--dangerously-skip-permissions" })).toThrow(RuntimeSessionError);
      expect(() => build({ model: "--dangerously-skip-permissions" })).toThrow(
        /invalid .* model id/,
      );
    });

    it(`${build.name} passes sanitized model through`, () => {
      expect(build({ model: "  sonnet  " })).toContain("sonnet");
    });
  }

  it("codex resume branch validates too", () => {
    expect(() => buildCodexArgs({ model: "--sandbox", resumeThreadId: "thr_1" })).toThrow(
      RuntimeSessionError,
    );
  });
});

describe("buildArgs omit --model for the default pseudo-model", () => {
  const builders = [buildOpencodeArgs, buildClaudeArgs, buildCodexArgs] as const;
  for (const build of builders) {
    it(`${build.name} drops the flag for model "default" (CLI config)`, () => {
      expect(build({ model: "default" })).not.toContain("--model");
    });
  }

  it("codex resume branch omits it too", () => {
    const args = buildCodexArgs({ model: "default", resumeThreadId: "thr_1" });
    expect(args).not.toContain("--model");
    expect(args[args.length - 1]).toBe("thr_1");
  });
});
