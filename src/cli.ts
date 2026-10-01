import { pathToFileURL } from "node:url";
import { version } from "./index.js";
import {
  doctor,
  doctorExitCode,
  formatReport,
  type DoctorReport,
  type DoctorUpdate,
} from "./doctor.js";
import { runtimes } from "./runtimes.js";
import type { RuntimeRegistry } from "./core/registry.js";
import type { InstallManager } from "./discovery/installs.js";
import { fetchLatestVersion, updateAvailable } from "./discovery/updates.js";

/** npm identity of this package — the self-update check target. */
export const SELF_PACKAGE = "@stratosphereslab/agent-runtimes";

/**
 * Managers with an unambiguous global-add spelling get a copy-paste
 * command; everything else (winget/scoop/brew/version managers) gets a
 * version-only nudge — prescribing a command we cannot verify would be
 * worse than silence.
 */
const GLOBAL_ADD: Partial<Record<InstallManager, string>> = {
  npm: "npm i -g",
  pnpm: "pnpm add -g",
  bun: "bun add -g",
};

function usage(registry: CliRegistry): string {
  return `Usage: agent-runtimes [-d|--doctor] [<runtime-id>] [--json] | doctor [<runtime-id>] [--json] | [-h|--help|-help|help] | [-V|--version]

No id checks every registered runtime (missing ones report, never abort
the rest). --json prints machine-readable reports for setup wizards.
Available runtimes: ${registry.list().join(", ")}`;
}

/** Registry surface the CLI needs: enumerate + resolve. */
type CliRegistry = Pick<RuntimeRegistry, "resolve" | "list">;

/** Extra seams for tests (a stub registry server instead of npmjs). */
export interface CliOptions {
  /** Registry base for the self-update check only; agent checks are untouched. */
  updateRegistry?: string;
  /** Skip the self-update check (tests, offline scripts — production leaves it on). */
  skipSelfUpdate?: boolean;
}

/**
 * One stderr nudge line for a report's update facts, or null when there is
 * nothing to say. Pure (no I/O) so tests cover every branch hermetically.
 * Human prose only — `--json` consumers read `report.updates` instead.
 */
export function formatUpdateHint(report: { id: string; updates?: DoctorUpdate[] }): string | null {
  const update = report.updates?.[0];
  if (!update) return null;
  const pace = `${report.id} ${update.installed} → ${update.latest}`;
  const add = GLOBAL_ADD[update.manager];
  return add !== undefined
    ? `↻ update: ${pace} — run: ${add} ${update.package}`
    : `↻ update: ${pace} available (${update.manager}-managed — upgrade it the way you installed it)`;
}

/**
 * The bin's own freshness, checked once per invocation no matter how many
 * runtimes are doctored. Fail-open like every other update probe (offline
 * yields null, never an error row or a nag).
 */
async function selfUpdateHint(updateRegistry?: string): Promise<string | null> {
  const latest = await fetchLatestVersion(
    SELF_PACKAGE,
    updateRegistry ? { registry: updateRegistry } : {},
  );
  if (!latest || !updateAvailable(version, latest)) return null;
  return `↻ update: agent-runtimes ${version} → ${latest} — run: npm i -g ${SELF_PACKAGE}`;
}

/**
 * CLI entry. Takes argv explicitly (default: process args) so tests can
 * invoke it without spawning a child process. Returns the exit code
 * instead of calling process.exit for the same reason.
 *
 * Two spellings reach the same path: the `doctor [<id>]` subcommand (also
 * what local builds use: `node dist/cli.js doctor [<id>]`) and the shorter
 * `-d|--doctor [<id>]` flag form for the installed `agent-runtimes` bin.
 * A bare `-d`/`--doctor`/`doctor` checks every registered runtime.
 *
 * Help is deliberately liberal: `-h`, `--help`, `-help`, and bare `help`
 * all print usage with exit 0. Nothing else gets an alias — unknown
 * commands stay exit 2.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  registry: CliRegistry = runtimes,
  opts?: CliOptions,
): Promise<number> {
  // --json anywhere enables machine-readable output (for setup wizards);
  // everything else routes on position as before.
  const json = argv.includes("--json");
  const [cmd, id] = argv.filter((a) => a !== "--json");
  if (cmd === "-h" || cmd === "--help" || cmd === "-help" || cmd === "help") {
    console.log(usage(registry));
    return 0;
  }
  if (cmd === "-V" || cmd === "--version") {
    console.log(version);
    return 0;
  }
  if (cmd === "-d" || cmd === "--doctor") {
    if (id) return runOne(registry, id, json, opts);
    return runAll(registry, json, opts);
  }
  if (cmd === "doctor") {
    if (id) return runOne(registry, id, json, opts);
    return runAll(registry, json, opts);
  }
  console.log(usage(registry));
  return 2;
}

async function runOne(
  registry: CliRegistry,
  runtimeId: string,
  json: boolean,
  opts?: CliOptions,
): Promise<number> {
  try {
    const report = await doctor(runtimeId, registry);
    const code = doctorExitCode(report);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return code;
    }
    console.log(formatReport(report));
    // Nudges ride stderr (stdout stays pipe-safe) and never touch the
    // exit code — an available update is information, not failure.
    const hint = formatUpdateHint(report);
    if (hint) console.error(hint);
    if (!opts?.skipSelfUpdate) {
      const self = await selfUpdateHint(opts?.updateRegistry);
      if (self) console.error(self);
    }
    return code;
  } catch (err) {
    // Errors stay human-readable even under --json: a thrown error means
    // no report exists to serialize, and exit 1 already signals failure.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Check every registered runtime, printing each report. A runtime that
 * cannot be checked (unknown id, dead probe) reports its error inline
 * and never aborts the rest. Exit 1 when anything failed, 0 when all
 * reports are clean.
 */
async function runAll(registry: CliRegistry, json: boolean, opts?: CliOptions): Promise<number> {
  const reports: Array<DoctorReport | { id: string; error: string }> = [];
  let failed = false;
  for (const id of registry.list()) {
    try {
      const report = await doctor(id, registry);
      reports.push(report);
      if (!json) {
        console.log(formatReport(report));
        console.log("");
        const hint = formatUpdateHint(report);
        if (hint) console.error(hint);
      }
      if (doctorExitCode(report) !== 0) failed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (json) {
        // Machine consumers need the failure attributed, not just absent.
        reports.push({ id, error: message });
      } else {
        console.log(`### ${id}: error: ${message}`);
        console.log("");
      }
      failed = true;
    }
  }
  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else if (!opts?.skipSelfUpdate) {
    const self = await selfUpdateHint(opts?.updateRegistry);
    if (self) console.error(self);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
