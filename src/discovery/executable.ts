import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./run-command.js";
import { resolveShimTarget } from "./npm-shim.js";

/**
 * Locate the executable for a command via PATH.
 * Uses `where` on Windows and `which -a` on POSIX (all matches).
 * Among every candidate (PATH hits + known install locations),
 * returns the one reporting the newest `--version`.
 * Returns null if not found.
 */
export async function findExecutable(
  command: string,
  aliases: string[] = [],
): Promise<string | null> {
  // Env override — matches daemon's CLAUDE_BIN / CODEX_BIN / OPENCODE_BIN
  const envOverride = getEnvOverride(command);
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }
  const candidates = [command, ...aliases];
  for (const candidate of candidates) {
    const hits = await whichAll(candidate);
    if (hits.length > 0) {
      const best = await pickBestExecutable(hits, candidate);
      if (best) return best;
      // All hits were not invocable (broken shims) — try next alias
    }
  }
  return null;
}

function getEnvOverride(command: string): string | null {
  const key = `${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
  const val = process.env[key];
  if (val && val.trim().length > 0) return val.trim();
  // Also support generic AGENT_BIN for opencode's OD_AGENT_HOME pattern
  if (command === "opencode" && process.env["OPENCODE_BIN"]) return process.env["OPENCODE_BIN"] ?? null;
  if (command === "claude" && process.env["CLAUDE_BIN"]) return process.env["CLAUDE_BIN"] ?? null;
  if (command === "codex" && process.env["CODEX_BIN"]) return process.env["CODEX_BIN"] ?? null;
  return null;
}

async function pickBestExecutable(primaries: string[], command: string): Promise<string | null> {
  const fallback = primaries[0];
  if (fallback === undefined) {
    throw new Error("pickBestExecutable: primaries must not be empty");
  }
  const seen = new Set<string>();
  const candidates = [...primaries, ...extraProbePaths(command)].filter((p) => {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(p);
  });
  let best: string | null = null;
  let bestVer: string | null = null;
  let anyInvocable = false;
  for (const cand of candidates) {
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
      if (invocable) anyInvocable = true;
    }
  }
  if (best) return best;
  // No versioned candidate, but at least one is invocable — return first invocable
  for (const cand of candidates) {
    if (await isInvocable(cand)) return cand;
  }
  // All candidates are broken shims — report not found so next alias can be tried
  return anyInvocable ? fallback : null;
}

async function isInvocable(executable: string): Promise<boolean> {
  // .cmd shims are not directly spawnable with shell:false, but are usable via resolveShimTarget (codex)
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const shim = resolveShimTarget(executable, "win32");
    if (shim) return true;
  }
  const res = await runCommand({ command: executable, args: ["--version"] });
  if (res.timedOut) return false;
  // Not invocable if spawn failed (ENOENT etc.) — runCommand returns code null with empty output
  if (res.code === null && res.stdout.trim().length === 0 && res.stderr.trim().length === 0) return false;
  return true;
}

/**
 * Known install locations outside PATH, per OS.
 * Still opencode-specific (Rule 1 tension, see docs/cross-platform.md §1);
 * generalize into ExecutableDefinition before adding the next agent family.
 */
function extraProbePaths(command: string): string[] {
  if (command !== "opencode") return [];
  if (process.platform === "win32") {
    const extras: string[] = [];
    // npm global location for the bundled exe (not on PATH).
    const appData = process.env["APPDATA"];
    if (appData) {
      extras.push(join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    }
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) {
      extras.push(join(localAppData, "Programs", "bun", "bin", "opencode.exe"));
    }
    // bun's default install location, derived from env
    // (never hardcode a username — breaks on any other machine).
    const homeDir = process.env["USERPROFILE"] ?? process.env["HOME"];
    if (homeDir) {
      extras.push(join(homeDir, ".bun", "bin", "opencode.exe"));
    }
    return extras;
  }
  const extras: string[] = ["/usr/local/bin/opencode", "/opt/homebrew/bin/opencode"];
  const home = process.env["HOME"];
  if (home) {
    extras.unshift(join(home, ".bun", "bin", "opencode"));
  }
  return extras;
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
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/** All PATH hits for a command, ordered by spawn preference. */
async function whichAll(cmd: string): Promise<string[]> {
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
