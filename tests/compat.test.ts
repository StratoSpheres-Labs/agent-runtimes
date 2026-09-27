import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERSION_FLOORS,
  evidenceMentionsMinimum,
  isWellFormedTested,
  testedOf,
} from "../src/definition/compat.js";
import {
  mergeTestedVersions,
  normalizeObservedVersion,
  recordFileFor,
  rewriteTestedArray,
} from "../src/discovery/compat-record.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { opencodeAcpDefinition } from "../runtimes/opencode-acp/definition.js";
import { claudeDefinition } from "../runtimes/claude/definition.js";
import { codexDefinition } from "../runtimes/codex/definition.js";

const DEFINITIONS = [opencodeDefinition, opencodeAcpDefinition, claudeDefinition, codexDefinition];

describe("tested tables stay well-formed", () => {
  it("every definition's tested list is semver and ascending", () => {
    const tested = testedOf(DEFINITIONS);
    expect(Object.keys(tested).sort()).toEqual(["claude", "codex", "opencode", "opencode-acp"]);
    for (const [id, list] of Object.entries(tested)) {
      expect(isWellFormedTested(list), `${id}: [${list.join(", ")}]`).toBe(true);
    }
    expect(isWellFormedTested(["1.0.0", "1.0.0"])).toBe(false);
    expect(isWellFormedTested(["2.0.0", "1.0.0"])).toBe(false);
    expect(isWellFormedTested(["nightly"])).toBe(false);
    expect(isWellFormedTested(undefined)).toBe(true);
  });
});

describe("VERSION_FLOORS evidence rule", () => {
  it("every definition minimum matches a floor entry", () => {
    for (const d of DEFINITIONS) {
      const minimum = d.versionPolicy?.minimum;
      if (!minimum) continue;
      const hit = VERSION_FLOORS.find((f) => f.runtime === d.identity.id && f.minimum === minimum);
      expect(hit, `${d.identity.id} minimum ${minimum} has no VERSION_FLOORS entry`).toBeDefined();
    }
  });

  it("every floor cites a test file that names the floor version", () => {
    expect(VERSION_FLOORS.length).toBeGreaterThan(0);
    for (const floor of VERSION_FLOORS) {
      const path = join(process.cwd(), floor.evidence);
      expect(existsSync(path), `evidence missing: ${floor.evidence}`).toBe(true);
      const text = readFileSync(path, "utf-8");
      expect(
        evidenceMentionsMinimum(text, floor.minimum),
        `${floor.evidence} never mentions ${floor.minimum}`,
      ).toBe(true);
    }
  });
});

describe("compat-record pure helpers", () => {
  it("normalizes raw versions, drops garbage", () => {
    expect(normalizeObservedVersion("2.1.276 (Claude Code)")).toBe("2.1.276");
    expect(normalizeObservedVersion("codex-cli 0.150.1")).toBe("0.150.1");
    expect(normalizeObservedVersion(null)).toBeNull();
    expect(normalizeObservedVersion("nightly-abc123")).toBeNull();
  });

  it("merges append-only, sorted, deduped", () => {
    expect(mergeTestedVersions(["1.18.27", "1.18.31"], ["1.18.32 (Opencode)", "1.18.31"])).toEqual([
      "1.18.27",
      "1.18.31",
      "1.18.32",
    ]);
    // Never deletes: old entries stay as the warn baseline.
    expect(mergeTestedVersions(["0.150.1"], [])).toEqual(["0.150.1"]);
    expect(mergeTestedVersions([], ["nightly"])).toEqual([]);
  });

  it("rewrites only the tested array literal", () => {
    const src = `  versionPolicy: {\n    minimum: "0.143.0",\n    tested: ["0.150.1"],\n  },`;
    expect(rewriteTestedArray(src, ["0.150.1", "0.155.0"])).toBe(
      `  versionPolicy: {\n    minimum: "0.143.0",\n    tested: ["0.150.1", "0.155.0"],\n  },`,
    );
    expect(rewriteTestedArray("no policy here", ["1.0.0"])).toBeNull();
  });

  it("maps runtimes to files, acp shares opencode's policy", () => {
    expect(recordFileFor("opencode")).toBe("runtimes/opencode/definition.ts");
    expect(recordFileFor("claude")).toBe("runtimes/claude/definition.ts");
    expect(recordFileFor("codex")).toBe("runtimes/codex/definition.ts");
    expect(recordFileFor("opencode-acp")).toBeNull();
    expect(recordFileFor("nope")).toBeNull();
  });
});
