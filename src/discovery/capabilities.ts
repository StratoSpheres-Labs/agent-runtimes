import { runCommand } from "./run-command.js";
import type { RuntimeCapabilities } from "../definition/capability.js";

/**
 * Phase 14 — capability probing via `command --help`
 * Mirrors open-design's `runtimes/capabilities.ts`:
 * scan help text for flags before using them (old CLIs crash on unknown flags).
 */

export async function probeHelpFlags(
  command: string,
  flags: string[],
  helpArgs: string[] = ["--help"],
): Promise<Record<string, boolean>> {
  const helpText = await getHelpText(command, helpArgs);
  const result: Record<string, boolean> = {};
  for (const flag of flags) {
    result[flag] = helpText.includes(flag);
  }
  return result;
}

async function getHelpText(command: string, helpArgs: string[]): Promise<string> {
  const res = await runCommand({ command, args: helpArgs });
  // On timeout the output may be partial — treat as no data so capability
  // gating fails safe (omits flags) instead of acting on truncated help.
  if (res.timedOut) return "";
  return res.stdout + res.stderr;
}

/**
 * Map help flags to RuntimeCapabilities overrides.
 * Example: if `--add-dir` not in help, don't advertise sessionResume that needs it.
 */
export function capabilitiesFromHelp(
  base: RuntimeCapabilities,
  helpFlags: Record<string, boolean>,
): RuntimeCapabilities {
  // v0.1: only gate streaming/sessionResume on help; others pass through
  // Real open-design gates many more (e.g. --include-partial-messages)
  return {
    ...base,
    streaming: helpFlags["--output-format stream-json"] ?? base.streaming,
    sessionResume:
      helpFlags["--resume"] || helpFlags["--session"] || helpFlags["resume"]
        ? true
        : base.sessionResume,
    workspace:
      helpFlags["--add-dir"] ||
      helpFlags["--dir"] ||
      helpFlags["-C"] ||
      helpFlags["--sandbox"] ||
      helpFlags["--permission-mode"] ||
      helpFlags["--dangerously-skip-permissions"]
        ? true
        : base.workspace,
  };
}
