import { homedir } from "node:os";
import { delimiter } from "node:path";
import { userToolchainBinDirs } from "./toolchain.js";

/**
 * Minimal env convergence — Sprint 3.
 * Mirrors daemon's `runtimes/env.ts: spawnEnvForAgent` but only the
 * cross-cutting parts that affect stability in pnpm workspaces / Windows.
 * Per-agent mutations are tiny and live here (Rule 1: no `if(id==="xxx")` in src/core).
 */

export function buildAgentEnv(
  agentId: string,
  baseEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, ...extraEnv };
  normalizeProxyEnv(env);
  appendToolchainToPath(env);

  // Windows HOME/USERPROFILE backfill (daemon does this for opencode/mimo)
  if (process.platform === "win32") {
    const profile = readEnv(env, "USERPROFILE");
    const home = readEnv(env, "HOME");
    if (!profile && home) env["USERPROFILE"] = home;
    if (!home && profile) env["HOME"] = profile;
    const resolvedProfile = readEnv(env, "USERPROFILE");
    if (!readEnv(env, "LOCALAPPDATA") && resolvedProfile) {
      // best-effort, matches daemon's backfill
      env["LOCALAPPDATA"] = `${resolvedProfile}\\AppData\\Local`;
    }
    if (!readEnv(env, "APPDATA") && resolvedProfile) {
      env["APPDATA"] = `${resolvedProfile}\\AppData\\Roaming`;
    }
    // Cache/temp locations CLIs use at startup (GUI-launched daemons often
    // lack these despite a resolvable PATH).
    const localAppData = readEnv(env, "LOCALAPPDATA");
    if (localAppData) {
      if (!readEnv(env, "TEMP")) env["TEMP"] = `${localAppData}\\Temp`;
      if (!readEnv(env, "TMP")) env["TMP"] = `${localAppData}\\Temp`;
    }
  } else {
    if (!env["HOME"]) {
      const h = homedir();
      if (h) env["HOME"] = h;
    }
  }

  // Opencode / MIMO: prevent `bun install` corrupting pnpm workspace
  if (agentId === "opencode" || agentId === "opencode-acp" || agentId === "mimo") {
    env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true";
    env["MIMOCODE_DISABLE_PROJECT_CONFIG"] = "true";
    // Strip stale server vars a previous `opencode serve` may have left
    // (daemon strips the same set — a leaked RUN_ID/PASSWORD would make the
    // child phone home to someone else's server).
    stripKeys(env, [
      "OPENCODE",
      "OPENCODE_PID",
      "OPENCODE_PPID",
      "OPENCODE_RUN_ID",
      "OPENCODE_SERVER_PASSWORD",
    ]);
  }
  if (agentId === "mimo") {
    stripKeys(env, [
      "MIMOCODE",
      "MIMOCODE_PID",
      "MIMOCODE_PPID",
      "MIMOCODE_RUN_ID",
      "MIMOCODE_SERVER_PASSWORD",
    ]);
  }

  // Codex: ensure CODEX_HOME is set (daemon sets it to `~/.codex`)
  if (agentId === "codex") {
    if (!readEnv(env, "CODEX_HOME")) {
      const h = readEnv(env, "HOME") ?? homedir();
      if (h) env["CODEX_HOME"] = `${h}/.codex`;
    }
  }

  return env;
}

/**
 * Case-aware env read: exact match on POSIX (casing is significant),
 * case-insensitive on Windows (the OS folds names). Writes always use the
 * canonical case; a pre-existing oddly-cased twin is left in place.
 */
function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Case-insensitive key removal (Windows env names are case-insensitive). */
function stripKeys(env: Record<string, string | undefined>, keys: readonly string[]): void {
  const upper = new Set(keys.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (upper.has(key.toUpperCase())) Reflect.deleteProperty(env, key);
  }
}

/**
 * Mirror proxy variables across cases (`http_proxy` ⇄ `HTTP_PROXY`).
 * Tools disagree on casing (curl/git read lowercase, many SDKs uppercase),
 * so a single-cased setting silently drops proxying for half the toolchain.
 * Only fills the missing side; when both sides are explicitly (and
 * differently) set, hands off — explicit intent wins over guessing.
 * Empty values count as absent and are never mirrored.
 */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

function normalizeProxyEnv(env: Record<string, string | undefined>): void {
  for (const upperName of PROXY_KEYS) {
    // Exact canonical casings only: a single physical key matching both
    // cases (e.g. only `http_proxy` set) must read as "one side set", not
    // "both sides agree". Anything exotic is left untouched.
    const upperVal = env[upperName]?.trim();
    const lowerVal = env[upperName.toLowerCase()]?.trim();
    if (upperVal && !lowerVal) {
      env[upperName.toLowerCase()] = upperVal;
    } else if (lowerVal && !upperVal) {
      env[upperName] = lowerVal;
    }
  }
}

/**
 * Append user toolchain bin dirs missing from PATH (resolution/spawn
 * symmetry). Appended — never prepended — so an explicit user PATH order
 * keeps winning; only fills gaps GUI-launched hosts leave behind.
 */
function appendToolchainToPath(env: Record<string, string | undefined>): void {
  const pathKey =
    process.platform === "win32"
      ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH")
      : "PATH";
  const current = (env[pathKey] ?? "").split(delimiter).filter((d) => d.length > 0);
  const seen = new Set(
    process.platform === "win32" ? current.map((d) => d.toLowerCase()) : current,
  );
  // Toolchain source is the env under construction (usually ambient) — never
  // process.env directly, so callers with custom bases (tests, Electron main
  // with a curated env) get dirs matching THEIR home, not ours.
  const home = readEnv(env, "HOME") ?? readEnv(env, "USERPROFILE") ?? homedir();
  const missing = userToolchainBinDirs({ env, home }).filter((d) => {
    const key = process.platform === "win32" ? d.toLowerCase() : d;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (missing.length > 0) {
    env[pathKey] = [...current, ...missing].join(delimiter);
  }
}
