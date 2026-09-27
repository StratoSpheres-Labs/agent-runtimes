import type { RuntimeDefinition } from "./index.js";
import { compareSemver, parseSemver } from "../discovery/version.js";

/**
 * Evidence-backed version floors — the single home for "this old CLI is
 * known broken". Every entry needs a `reason` (observed breakage, one
 * line) and an `evidence` file proving it (a test asserting the breakage
 * — `tests/compat.test.ts` enforces the file exists and mentions the
 * floor). Floors are reactive by design: never invent one for a version
 * nobody ran, only record breakage that actually bit.
 *
 * Adapter `minimum` fields stay self-contained in their definitions, but
 * their values must match an entry here (enforced by test) — one source
 * of truth, two read paths.
 */
export interface VersionFloor {
  /** Runtime id, e.g. `"codex"`. */
  runtime: string;
  /** Hard floor, e.g. `"0.143.0"`. */
  minimum: string;
  /** Scoped to one model id when set (model↔CLI contracts). */
  model?: string;
  /** Observed breakage, one line. */
  reason: string;
  /** Test file proving the breakage, e.g. `"tests/codex-config.test.ts"`. */
  evidence: string;
}

export const VERSION_FLOORS: readonly VersionFloor[] = [
  {
    runtime: "codex",
    minimum: "0.143.0",
    model: "gpt-5.6-terra",
    reason: "production traces show <0.143.0 rejecting ChatGPT-backed gpt-5.6-terra",
    evidence: "tests/codex-config.test.ts",
  },
];

/**
 * Whether a source text references a floor version. Backslash-insensitive
 * on purpose: evidence usually cites the version inside a regex
 * (`/0\.143\.0/`), and that counts — the point is "some test names this
 * floor", not exact typography.
 */
export function evidenceMentionsMinimum(sourceText: string, minimum: string): boolean {
  return sourceText.replace(/\\/g, "").includes(minimum);
}

/** Floors scoped to one runtime (model-specific and general). */
export function floorsFor(runtime: string): VersionFloor[] {
  return VERSION_FLOORS.filter((f) => f.runtime === runtime);
}

/** Minimum CLI for one model, or null when no contract covers it. */
export function modelCliFloor(runtime: string, model: string): string | null {
  const hit = VERSION_FLOORS.find((f) => f.runtime === runtime && f.model === model);
  return hit?.minimum ?? null;
}

/**
 * Whether every `tested` entry is a parseable semver in strictly ascending
 * order — the `pnpm compat:record` invariant (hand edits and script writes
 * both obey it; `tests/compat.test.ts` enforces it per definition).
 */
export function isWellFormedTested(tested: readonly string[] | undefined): boolean {
  if (!tested) return true;
  let prev: string | null = null;
  for (const t of tested) {
    const cur = parseSemver(t);
    if (!cur) return false;
    if (prev !== null) {
      const prevParsed = parseSemver(prev);
      if (!prevParsed || compareSemver(cur, prevParsed) <= 0) return false;
    }
    prev = t;
  }
  return true;
}

/** Collect every definition's `tested` list for the compat test. */
export function testedOf(definitions: readonly RuntimeDefinition[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of definitions) {
    out[d.identity.id] = [...(d.versionPolicy?.tested ?? [])];
  }
  return out;
}
