import { runCommand } from "./run-command.js";
import type { RuntimeModel } from "../definition/model.js";

/**
 * Phase 16 — live model discovery
 * Tries `command ...listCommand` (e.g. `opencode models`) and falls back to static list.
 * Parses newline-separated `provider/model` ids.
 */
export async function discoverModels(
  command: string,
  listCommand: string[] = ["models"],
  fallback: RuntimeModel[] = [],
): Promise<RuntimeModel[]> {
  const live = await probeModels(command, listCommand);
  if (live.length > 0) return live;
  return fallback;
}

async function probeModels(command: string, args: string[]): Promise<RuntimeModel[]> {
  const res = await runCommand({ command, args });
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
