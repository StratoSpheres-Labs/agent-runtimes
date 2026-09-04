import { homedir } from "node:os";

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

  // Windows HOME/USERPROFILE backfill (daemon does this for opencode/mimo)
  if (process.platform === "win32") {
    if (!env["USERPROFILE"] && env["HOME"]) env["USERPROFILE"] = env["HOME"];
    if (!env["HOME"] && env["USERPROFILE"]) env["HOME"] = env["USERPROFILE"];
    if (!env["LOCALAPPDATA"] && env["USERPROFILE"]) {
      // best-effort, matches daemon's backfill
      env["LOCALAPPDATA"] = `${env["USERPROFILE"]}\\AppData\\Local`;
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
    // Strip stale PID that daemon strips as well
    delete env["OPENCODE_PID"];
    delete env["OPENCODE_PPID"];
  }

  // Codex: ensure CODEX_HOME is set (daemon sets it to `~/.codex`)
  if (agentId === "codex") {
    if (!env["CODEX_HOME"]) {
      const h = env["HOME"] ?? homedir();
      if (h) env["CODEX_HOME"] = `${h}/.codex`;
    }
  }

  return env;
}
