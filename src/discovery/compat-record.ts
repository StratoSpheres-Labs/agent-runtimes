import { compareSemver, parseSemver } from "./version.js";

/**
 * `pnpm compat:record` machinery — refresh the hand-kept `tested` arrays
 * without thought. Pure helpers (unit-tested); the thin CLI wrapper lives
 * in `scripts/compat-record.ts`.
 *
 * Rules: append-only (never delete an entry — old versions stay as the
 * "older than tested" warn baseline), semver-normalized, strictly
 * ascending, deduped. Unparseable observations are dropped (nightlies,
 * `latest` tags), never written.
 */

/** Normalize one observed version (`"2.1.276 (Claude Code)"` → `"2.1.276"`). */
export function normalizeObservedVersion(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = parseSemver(raw);
  if (!parsed) return null;
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`;
}

/** Merge observed versions into an existing `tested` list (pure). */
export function mergeTestedVersions(
  existing: readonly string[],
  observed: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...observed]) {
    const norm = normalizeObservedVersion(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort((a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return 0;
    return compareSemver(pa, pb);
  });
  return out;
}

/**
 * Rewrite the `tested: [...]` array literal in a definition source file.
 * Returns the updated source, or null when no `tested:` array is found
 * (caller skips the file — never a partial write).
 */
export function rewriteTestedArray(source: string, versions: readonly string[]): string | null {
  const match = /tested:\s*\[([^\]]*)\]/.exec(source);
  if (!match) return null;
  const rendered = versions.map((v) => `"${v}"`).join(", ");
  return `${source.slice(0, match.index)}tested: [${rendered}]${source.slice(match.index + match[0].length)}`;
}

/**
 * Definition file owning a runtime's `tested` array. `opencode-acp`
 * shares opencode's policy object — it maps to null (nothing to write).
 */
export function recordFileFor(runtimeId: string): string | null {
  switch (runtimeId) {
    case "opencode":
      return "runtimes/opencode/definition.ts";
    case "claude":
      return "runtimes/claude/definition.ts";
    case "codex":
      return "runtimes/codex/definition.ts";
    default:
      return null;
  }
}

/** Runtimes the record script walks (registry ids, not file paths). */
export const RECORD_RUNTIME_IDS: readonly string[] = ["opencode", "claude", "codex"];
