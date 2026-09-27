import { pathToFileURL } from "node:url";
import { doctor, doctorExitCode, formatReport } from "./doctor.js";

const USAGE = `Usage: agent-runtimes [-d|--doctor] <runtime-id> | doctor <runtime-id>

Available runtimes: opencode, claude, codex`;

/**
 * CLI entry. Takes argv explicitly (default: process args) so tests can
 * invoke it without spawning a child process. Returns the exit code
 * instead of calling process.exit for the same reason.
 *
 * Two spellings reach the same path: the `doctor <id>` subcommand (also
 * what local builds use: `node dist/cli.js doctor <id>`) and the shorter
 * `-d|--doctor <id>` flag form for the installed `agent-runtimes` bin.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, id] = argv;
  if (cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }
  const runtimeId = cmd === "doctor" || cmd === "-d" || cmd === "--doctor" ? id : undefined;
  if (!runtimeId) {
    console.log(USAGE);
    return 2;
  }
  try {
    const report = await doctor(runtimeId);
    console.log(formatReport(report));
    return doctorExitCode(report);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
