import { runCommand } from "./run-command.js";
import { resolveLaunch } from "./launch.js";
import { RuntimeSessionError } from "../core/errors.js";
import type { RuntimeModel } from "../definition/model.js";

/**
 * Phase 16 — live model discovery
 * Tries `command ...listCommand` (e.g. `opencode models`) and falls back to static list.
 * Parses newline-separated `provider/model` ids.
 * `timeoutMs` bounds the probe: catalog calls can hit the network
 * (`opencode models` regularly takes >8s), so slow networks need more
 * than the 10s default or the live list degrades to fallback silently.
 */
export async function discoverModels(
  command: string,
  listCommand: string[] = ["models"],
  fallback: RuntimeModel[] = [],
  timeoutMs = 10_000,
): Promise<RuntimeModel[]> {
  const live = await probeModels(command, listCommand, timeoutMs);
  if (live.length > 0) return live;
  return fallback;
}

async function probeModels(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RuntimeModel[]> {
  // Shim-aware: a win32 npm `.cmd` cannot be spawned directly (EINVAL) —
  // resolve through host node first. Native binaries pass through untouched.
  const launch = resolveLaunch(command);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...args],
    env: launch.env,
    timeout: timeoutMs,
  });
  if (res.timedOut || res.code !== 0) return [];
  const models: RuntimeModel[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || id.startsWith("#") || id.includes(" ")) continue;
    // opencode outputs `provider/model` per line
    const slash = id.indexOf("/");
    if (slash > 0) {
      models.push({ id, provider: id.slice(0, slash), name: id.slice(slash + 1) });
    } else {
      models.push({ id });
    }
  }
  return models;
}

/**
 * Last live-surfaced model list per agent id, primed by `models()` calls.
 * Order-time validation reads it; a transient probe failure keeps serving
 * the remembered list instead of degrading to empty (daemon parity).
 * Only non-empty lists are remembered — an empty probe result means
 * "unknown", never "no models exist".
 */
const liveModelCache = new Map<string, RuntimeModel[]>();

export function rememberLiveModels(agentId: string, models: RuntimeModel[]): void {
  if (models.length === 0) return;
  liveModelCache.set(agentId, [...models]);
}

/** Drop remembered lists for one agent (or all when omitted) — rescan. */
export function clearLiveModels(agentId?: string): void {
  if (agentId === undefined) {
    liveModelCache.clear();
    return;
  }
  liveModelCache.delete(agentId);
}

/**
 * Whether `modelId` plausibly exists: in the remembered live list or the
 * static fallback (exact, case-sensitive — CLI ids are). Fail-open when
 * nothing was ever surfaced: with no evidence either way, judging would
 * strand callers that never list before running.
 */
export function isKnownModel(
  agentId: string,
  modelId: string,
  fallback: readonly RuntimeModel[] = [],
): boolean {
  const remembered = liveModelCache.get(agentId);
  if (remembered === undefined) return true;
  if (remembered.some((m) => m.id === modelId)) return true;
  return fallback.some((m) => m.id === modelId);
}

/**
 * Reject unknown model picks before they reach the CLI. A rejected turn
 * never spawns, so it never mints a stillborn native session in the agent's
 * own history (and our persisted record never stores a typo'd model).
 * Fail-open unless there is evidence: unprimed cache passes; a primed miss
 * re-probes once via `refresh` (a brand-new model must not die on a stale
 * cache) and only throws when still unknown afterwards.
 */
export async function assertKnownModel(
  agentId: string,
  model: string | undefined,
  fallback: readonly RuntimeModel[] = [],
  refresh?: () => Promise<RuntimeModel[]>,
): Promise<void> {
  if (!model) return;
  if (isKnownModel(agentId, model, fallback)) return;
  if (refresh) {
    const fresh = await refresh().catch((): null => null);
    if (fresh && fresh.length > 0) {
      rememberLiveModels(agentId, fresh);
      if (isKnownModel(agentId, model, fallback)) return;
    }
  }
  throw new RuntimeSessionError(
    `unknown model "${model}" for ${agentId} — not in the live catalog or fallback list`,
    { runtime: agentId },
  );
}
