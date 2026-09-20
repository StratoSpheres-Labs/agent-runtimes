import { runCommand } from "./run-command.js";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Extract `major.minor.patch` from a raw version string
 * (`"codex-cli 0.150.1"` → `{0,150,1}`, `"2.1.187 (Claude Code)"` →
 * `{2,1,187}`). Prerelease/build suffixes intentionally fail open (null) —
 * only stable boundaries are ever enforced.
 */
export function parseSemver(value: string): SemVer | null {
  const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?![\dA-Za-z.+-])/.exec(value);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/** Compare two parsed versions: negative / 0 / positive. */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Probe a CLI for its version string.
 * Runs `command ...versionArgs` and returns trimmed stdout/stderr.
 * Returns null if the process fails or times out.
 * `env` replaces the spawn env when given (shimmed installs need harvested
 * extras merged over ambient); omit to inherit ambient.
 */
export async function probeVersion(
  command: string,
  versionArgs: string[] = ["--version"],
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const res = await runCommand({ command, args: versionArgs, env });
  if (res.timedOut) return null;
  const combined = (res.stdout + res.stderr).trim();
  if (combined.length === 0) return null;
  if (res.code !== 0) {
    // Some CLIs print version to stderr but exit non-zero; check both streams
    return combined.split(/\r?\n/)[0]?.trim() ?? null;
  }
  // First non-empty line is the version
  const line = combined.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim() ?? null;
}
