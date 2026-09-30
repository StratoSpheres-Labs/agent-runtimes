import { pathToFileURL } from "node:url";
import { version } from "./index.js";
import { doctor, doctorExitCode, formatReport, type DoctorReport } from "./doctor.js";
import { runtimes } from "./runtimes.js";
import type { RuntimeRegistry } from "./core/registry.js";

function usage(registry: CliRegistry): string {
  return `Usage: agent-runtimes [-d|--doctor] [<runtime-id>] [--json] | doctor [<runtime-id>] [--json] | [-h|--help|-help|help] | [-V|--version]

No id checks every registered runtime (missing ones report, never abort
the rest). --json prints machine-readable reports for setup wizards.
Available runtimes: ${registry.list().join(", ")}`;
}

/** Registry surface the CLI needs: enumerate + resolve. */
type CliRegistry = Pick<RuntimeRegistry, "resolve" | "list">;

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
    if (id) return runOne(registry, id, json);
    return runAll(registry, json);
  }
  if (cmd === "doctor") {
    if (id) return runOne(registry, id, json);
    return runAll(registry, json);
  }
  console.log(usage(registry));
  return 2;
}

async function runOne(registry: CliRegistry, runtimeId: string, json: boolean): Promise<number> {
  try {
    const report = await doctor(runtimeId, registry);
    console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
    return doctorExitCode(report);
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
async function runAll(registry: CliRegistry, json: boolean): Promise<number> {
  const reports: Array<DoctorReport | { id: string; error: string }> = [];
  let failed = false;
  for (const id of registry.list()) {
    try {
      const report = await doctor(id, registry);
      reports.push(report);
      if (!json) {
        console.log(formatReport(report));
        console.log("");
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
  if (json) console.log(JSON.stringify(reports, null, 2));
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
