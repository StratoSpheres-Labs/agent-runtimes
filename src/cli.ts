import { pathToFileURL } from "node:url";
import { doctor, doctorExitCode, formatReport } from "./doctor.js";

const USAGE = `Usage: agent-runtimes doctor <runtime-id>

Available runtimes: opencode, claude, codex`;

/**
 * CLI entry. Takes argv explicitly (default: process args) so tests can
 * invoke it without spawning a child process. Returns the exit code
 * instead of calling process.exit for the same reason.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, id] = argv;
  if (cmd !== "doctor" || !id) {
    console.log(USAGE);
    return 2;
  }
  try {
    const report = await doctor(id);
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
