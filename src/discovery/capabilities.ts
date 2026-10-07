import { runCommand } from "./run-command.js";
import { resolveLaunch } from "./launch.js";
import type { RuntimeCapabilities } from "../definition/capability.js";

/**
 * Phase 14 — capability probing via `command --help`
 * Mirrors open-design's `runtimes/capabilities.ts`:
 * scan help text for flags before using them (old CLIs crash on unknown flags).
 */

/**
 * Verdict for one flag.
 *
 * `"unknown"` is deliberately NOT `false`. It means the probe never read the
 * help text (it timed out, or the spawn failed), so we have no evidence either
 * way. Collapsing the two makes a slow or loaded machine look exactly like an
 * old CLI — and a false "this flag is absent" is indistinguishable from the
 * truth, so it cannot be corrected downstream. Same reasoning as
 * `probeInvocableVerdict` in `executable.ts`: inconclusive ≠ negative.
 */
export type HelpFlagVerdict = boolean | "unknown";

/** Outcome of one help-text probe, so callers can tell "no" from "did not look". */
export interface HelpFlagProbe {
  /** Per-flag verdict. Every flag passed in appears here, never absent. */
  readonly flags: Readonly<Record<string, HelpFlagVerdict>>;
  /** `"ok"` only when the help text was actually read to completion. */
  readonly status: "ok" | "timeout" | "error";
  /** `code` from the spawn, when `status` is `"error"`. */
  readonly code?: number | string | null;
}

/**
 * Probe `command --help` and report three states per flag.
 *
 * Prefer this over {@link probeHelpFlags} whenever the result can gate a
 * decision or reach a human: it distinguishes a CLI that genuinely lacks a
 * flag from a probe that never got to look.
 */
export async function probeHelpFlagsDetailed(
  command: string,
  flags: readonly string[],
  helpArgs: string[] = ["--help"],
): Promise<HelpFlagProbe> {
  const text = await getHelpText(command, helpArgs);
  const result: Record<string, HelpFlagVerdict> = {};
  // A failed probe yields "unknown" for every flag — never `false`, and never a
  // missing key, so no caller can mistake it for a negative answer.
  for (const flag of flags) {
    result[flag] = text.status === "ok" ? text.text.includes(flag) : "unknown";
  }
  return {
    flags: result,
    status: text.status,
    ...(text.code !== undefined ? { code: text.code } : {}),
  };
}

/**
 * Boolean-only view of {@link probeHelpFlagsDetailed}.
 *
 * Kept for the published signature: an unprobed flag reads `false` here, which
 * is the fail-safe direction (omit the flag rather than pass one the CLI may
 * reject). Use the detailed form if you need to report the difference.
 */
export async function probeHelpFlags(
  command: string,
  flags: readonly string[],
  helpArgs: string[] = ["--help"],
): Promise<Record<string, boolean>> {
  const probe = await probeHelpFlagsDetailed(command, flags, helpArgs);
  const result: Record<string, boolean> = {};
  for (const flag of flags) {
    result[flag] = probe.flags[flag] === true;
  }
  return result;
}

interface HelpTextResult {
  readonly text: string;
  readonly status: "ok" | "timeout" | "error";
  readonly code?: number | string | null;
}

async function getHelpText(command: string, helpArgs: string[]): Promise<HelpTextResult> {
  // Shim-aware like every other probe (Rule 7): a win32 `.cmd` path cannot
  // spawn directly with shell:false, so resolve to the node script or the
  // native binary first. Bare names pass through untouched.
  const launch = resolveLaunch(command);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...helpArgs],
    env: launch.env,
  });
  // Never act on partial help text: a timeout can truncate mid-flag (leaving
  // `--permission-m`), which would read as "absent" for a supported flag.
  if (res.timedOut) return { text: "", status: "timeout" };
  // A non-zero exit still prints usable help for most CLIs (`--help` exits 0
  // nearly everywhere, but a shim may not); only a spawn failure is "error",
  // matching runCommand's own `code: null, timedOut: false` split.
  if (res.code === null && res.stdout.length === 0 && res.stderr.length === 0) {
    return { text: "", status: "error", code: null };
  }
  return { text: res.stdout + res.stderr, status: "ok" };
}

/**
 * Help flags worth probing, shared by `DefaultRuntime.probeFlags()` and the
 * doctor Flags row. Only flags this library actually verified live may be
 * added here — never speculative ones (an unobserved flag would let the
 * probe bless a channel that doesn't exist). Bare `-p` is deliberately
 * absent: substring matching would false-positive on `--port` etc.
 */
export const ADVISORY_PROBE_FLAGS: readonly string[] = [
  "--resume",
  "--session",
  "resume",
  "--model",
  "--output-format stream-json",
  "--add-dir",
  "--dir",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--allowedTools",
  "--sandbox",
  "-C",
  "--agent",
  "--profile",
  "--variant",
];

/**
 * Map help flags to RuntimeCapabilities overrides.
 * Example: if `--add-dir` not in help, don't advertise sessionResume that needs it.
 *
 * Only a **definitive** `false` may downgrade a capability. `"unknown"` (or an
 * absent key) means the probe never read the help text, and an inconclusive
 * probe must leave `base` alone — otherwise a 10s probe timeout on a loaded box
 * silently strips `streaming` / `workspace` from a perfectly healthy CLI, with
 * nothing anywhere recording that the evidence was missing rather than negative.
 *
 * Accepts `boolean` values unchanged (`true | false | "unknown"` widens
 * `boolean`), so existing callers keep compiling.
 */
export function capabilitiesFromHelp(
  base: RuntimeCapabilities,
  helpFlags: Readonly<Record<string, HelpFlagVerdict>>,
): RuntimeCapabilities {
  /**
   * True if any candidate flag is definitively present.
   *
   * Deliberately NOT `flags.some(Boolean)`: `Boolean("unknown")` is `true`, so
   * that spelling would let one unprobed flag advertise a capability.
   */
  const anyPresent = (candidates: readonly string[]): boolean =>
    candidates.some((flag) => helpFlags[flag] === true);
  /** True only when a candidate was definitively checked and found absent. */
  const anyAbsent = (candidates: readonly string[]): boolean =>
    candidates.some((flag) => helpFlags[flag] === false);

  // v0.1: only gate streaming/sessionResume on help; others pass through
  // Real open-design gates many more (e.g. --include-partial-messages)
  const streaming = ["--output-format stream-json"];
  const resume = ["--resume", "--session", "resume"];
  const workspace = [
    "--add-dir",
    "--dir",
    "-C",
    "--sandbox",
    "--permission-mode",
    "--dangerously-skip-permissions",
  ];

  return {
    ...base,
    // Present → true. Absent → false (the flag genuinely is not there).
    // Unknown → base. All three branches now agree; `streaming` used to be
    // `?? base`, which treated a definitive `false` as an answer while the
    // other two capabilities fell through to base.
    streaming: anyPresent(streaming) ? true : anyAbsent(streaming) ? false : base.streaming,
    sessionResume: anyPresent(resume) ? true : base.sessionResume,
    workspace: anyPresent(workspace) ? true : base.workspace,
  };
}
