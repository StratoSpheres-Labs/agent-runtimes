import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { runCommand } from "./run-command.js";
import { resolveShimTarget } from "./npm-shim.js";
import { toolchainProbePaths } from "./toolchain.js";
import { compareSemver, parseSemver } from "./version.js";

/**
 * True when the OS could execute this path — recognized per platform, so
 * foreign-shim noise never enters the candidate set (bare POSIX shims on
 * Windows, `.cmd` shims on POSIX).
 * - win32: PATHEXT match required. Bare (extensionless) files are rejected:
 *   CreateProcess cannot run them, and real Windows binaries always carry
 *   an extension. (Escape hatch: explicit `*_BIN` overrides bypass this.)
 * - POSIX: the executable bit decides, except batch suffixes (`.cmd`,
 *   `.bat`, `.ps1`, `.com`), which no shebang can rescue. `.exe` stays
 *   bit-gated (fail-open): a misnamed native binary with `+x` is a
 *   candidate, the spawn probe decides.
 * Never throws. `platform` is injectable for hermetic cross-platform tests.
 */
export function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let isFile = false;
  try {
    isFile = statSync(candidate).isFile();
  } catch {
    return false;
  }
  if (!isFile) return false;
  if (platform === "win32") {
    const ext = extname(candidate).trim().toUpperCase();
    if (!ext) return false;
    const ok = (process.env["PATHEXT"] || ".EXE;.CMD;.BAT")
      .split(";")
      .map((e) => e.trim().toUpperCase())
      .filter((e) => e.length > 0);
    return ok.includes(ext);
  }
  const posixExt = extname(candidate).trim().toUpperCase();
  if ([".CMD", ".BAT", ".PS1", ".COM"].includes(posixExt)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories a PATH-based lookup walks, for diagnostics. Mirrors what
 * `whichAll` searches via `where`/`which` (current dir on win32 aside):
 * PATH entries, de-duplicated. No spawning — safe to call for display.
 * Definition `extraProbePaths` are intentionally excluded (few, static,
 * and already absolute when displayed elsewhere).
 */
export function agentSearchDirs(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (process.env["PATH"] ?? "").split(delimiter)) {
    const dir = raw.trim();
    if (!dir) continue;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Locate the executable for a command via PATH (+ definition extras).
 * Uses `where` on Windows and `which -a` on POSIX (all matches).
 * Among every candidate (PATH hits + `extras` + toolchain dirs),
 * returns the one reporting the newest `--version`.
 * Extras are consulted even with zero PATH hits (app-bundle-only installs).
 * Returns null if not found.
 */
export async function findExecutable(
  command: string,
  aliases: string[] = [],
  extras: readonly string[] = [],
): Promise<string | null> {
  // Env override — matches daemon's CLAUDE_BIN / CODEX_BIN / OPENCODE_BIN
  const envOverride = getEnvOverride(command);
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }
  const candidates = [command, ...aliases];
  for (const candidate of candidates) {
    const hits = await whichAll(candidate);
    const best = await pickBestExecutable(hits, candidate, extras);
    if (best) return best;
    // No invocable candidate (not on PATH, extras dead, or broken shims) —
    // try next alias.
  }
  return null;
}

/**
 * Proven-unusable executables, keyed by resolving bin name + normalized path.
 * A candidate lands here only when BOTH the version probe and the invocable
 * check fail (broken shim, missing target) — never for a binary that runs
 * but reports an unparseable version. Entries expire after
 * UNUSABLE_TTL_MS so a repaired/reinstalled CLI is picked up without a
 * process restart; `forgetUnusableExecutables` forces an immediate rescan.
 * Deliberately records what is *broken*, never the winner: PATH order stays
 * in charge of everything still standing (daemon parity).
 */
const UNUSABLE_TTL_MS = 60_000;
const unusableSince = new Map<string, number>();

function unusableKey(command: string, resolvedPath: string): string {
  const path = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  return JSON.stringify([command, path]);
}

/** Record an executable a detection pass proved could not be launched. */
export function rememberUnusableExecutable(command: string, resolvedPath: string): void {
  unusableSince.set(unusableKey(command, resolvedPath), Date.now());
}

/** Drop unusable records for one command (or all when omitted) — rescan. */
export function forgetUnusableExecutables(command?: string): void {
  if (command === undefined) {
    unusableSince.clear();
    return;
  }
  const prefix = `[${JSON.stringify(command)},`;
  for (const key of [...unusableSince.keys()]) {
    if (key.startsWith(prefix)) unusableSince.delete(key);
  }
}

function isRememberedUnusable(command: string, resolvedPath: string): boolean {
  const key = unusableKey(command, resolvedPath);
  const since = unusableSince.get(key);
  if (since === undefined) return false;
  if (Date.now() - since > UNUSABLE_TTL_MS) {
    unusableSince.delete(key);
    return false;
  }
  return true;
}

/**
 * Resolve definition-declared `extraProbePaths` against the user home.
 * Absolute paths pass through (normalized); `~`-prefixed paths expand;
 * anything else is ignored. Existence is NOT checked here — the candidate
 * filter in `pickBestExecutable` drops the missing (so macOS bundle paths
 * are harmless entries on Windows and vice versa).
 */
export function resolveExtraProbePaths(
  extra: readonly string[] | undefined,
  home?: string,
): string[] {
  if (!extra || extra.length === 0) return [];
  const base = home ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? homedir();
  const out: string[] = [];
  for (const raw of extra) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) {
      if (!base) continue;
      out.push(join(base, entry.slice(2)));
    } else if (isAbsolute(entry)) {
      out.push(entry);
    }
    // Bare relative entries are ignored — probing them would depend on the
    // caller's cwd, which detection must never do.
  }
  return out;
}
function getEnvOverride(command: string): string | null {
  const key = `${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
  const val = process.env[key];
  if (val && val.trim().length > 0) return val.trim();
  // Also support generic AGENT_BIN for opencode's OD_AGENT_HOME pattern
  if (command === "opencode" && process.env["OPENCODE_BIN"])
    return process.env["OPENCODE_BIN"] ?? null;
  if (command === "claude" && process.env["CLAUDE_BIN"]) return process.env["CLAUDE_BIN"] ?? null;
  if (command === "codex" && process.env["CODEX_BIN"]) return process.env["CODEX_BIN"] ?? null;
  return null;
}

async function pickBestExecutable(
  primaries: string[],
  command: string,
  extras: readonly string[] = [],
): Promise<string | null> {
  const fallback = primaries[0];
  const seen = new Set<string>();
  const candidates = [
    ...primaries,
    ...resolveExtraProbePaths(extras),
    ...toolchainProbePaths(command),
  ].filter((p) => {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    // Executability, not mere existence: a wrong-extension or +x-less file
    // on PATH was never going to spawn. Explicit *_BIN overrides bypass
    // this (user intent must fail loudly, not silently resolve elsewhere).
    return isExecutableFile(p);
  });
  let best: string | null = null;
  let bestVer: string | null = null;
  let anyInvocable = false;
  for (const cand of candidates) {
    // Skip paths a previous pass proved unlaunchable (TTL'd, rescan via
    // forgetUnusableExecutables) — saves a doomed spawn per candidate.
    if (isRememberedUnusable(command, cand)) continue;
    const ver = await probeVersionSafe(cand);
    if (ver) {
      anyInvocable = true;
      if (bestVer === null || compareVersions(ver, bestVer) > 0) {
        best = cand;
        bestVer = ver;
      }
    } else {
      // Check if candidate is invocable at all (even if version parse fails)
      const invocable = await isInvocable(cand);
      if (invocable) {
        anyInvocable = true;
      } else {
        rememberUnusableExecutable(command, cand);
      }
    }
  }
  if (best) return best;
  // No versioned candidate, but at least one is invocable — return first invocable
  for (const cand of candidates) {
    if (isRememberedUnusable(command, cand)) continue;
    if (await isInvocable(cand)) return cand;
  }
  // All candidates are broken shims — report not found so next alias can be tried
  return anyInvocable && fallback !== undefined ? fallback : null;
}

/** Spawn probe shared with findAllInstalls (shim-aware on win32). */
export async function isInvocable(executable: string): Promise<boolean> {
  // .cmd shims are not directly spawnable with shell:false, but are usable
  // via resolveShimTarget (node-script shims and native-binary shims alike)
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const shim = resolveShimTarget(executable, "win32");
    if (shim) return true;
  }
  const res = await runCommand({ command: executable, args: ["--version"] });
  if (res.timedOut) return false;
  // Not invocable if spawn failed (ENOENT etc.) — runCommand returns code null with empty output
  if (res.code === null && res.stdout.trim().length === 0 && res.stderr.trim().length === 0)
    return false;
  return true;
}

async function probeVersionSafe(executable: string): Promise<string | null> {
  const res = await runCommand({ command: executable, args: ["--version"] });
  if (res.timedOut) return null;
  const out = (res.stdout + res.stderr).trim();
  const v = out.split(/\r?\n/)[0]?.trim() ?? null;
  if (!v) return null;
  if (res.code !== 0 && !/^\d+\.\d+\.\d+/.test(v)) return null;
  return v;
}

function compareVersions(a: string, b: string): number {
  // Regex-extracted semver: raw probe strings carry prefixes/suffixes
  // (`"codex-cli 0.150.1"`, `"2.1.187 (Claude Code)"`) that naive splitting
  // misreads. Unparseable sides compare as 0.0.0 (never throw in discovery).
  const pa = parseSemver(a) ?? { major: 0, minor: 0, patch: 0 };
  const pb = parseSemver(b) ?? { major: 0, minor: 0, patch: 0 };
  return compareSemver(pa, pb);
}

/** All PATH hits for a command, ordered by spawn preference. Shared with findAllInstalls. */
export async function whichAll(cmd: string): Promise<string[]> {
  if (process.platform === "win32") {
    const res = await runCommand({ command: "where", args: [cmd] });
    if (res.timedOut || res.code !== 0) return [];
    return orderWindowsHits(splitLines(res.stdout));
  }
  // List every match so version comparison sees all installs.
  const all = await runCommand({ command: "which", args: ["-a", cmd] });
  const hits = all.timedOut || all.code !== 0 ? [] : splitLines(all.stdout);
  if (hits.length > 0) return hits;
  // `which -a` unsupported on minimal systems → plain `which`.
  const single = await runCommand({ command: "which", args: [cmd] });
  if (single.timedOut || single.code !== 0) return [];
  return splitLines(single.stdout);
}

function splitLines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// On Windows, `where` may return `opencode` (no ext), `opencode.cmd`, `opencode.exe`.
// Prefer .exe > .cmd > bare to match what `spawn(name)` with PATHEXT will actually run,
// and to avoid a stale shim shadowing a newer install.
function orderWindowsHits(lines: string[]): string[] {
  const isExe = (l: string): boolean => l.toLowerCase().endsWith(".exe");
  const isCmd = (l: string): boolean => l.toLowerCase().endsWith(".cmd");
  return [
    ...lines.filter((l) => isExe(l)),
    ...lines.filter((l) => !isExe(l) && isCmd(l)),
    ...lines.filter((l) => !isExe(l) && !isCmd(l)),
  ];
}
