import { runCommand } from "./run-command.js";

/**
 * Probe a CLI for its version string.
 * Runs `command ...versionArgs` and returns trimmed stdout/stderr.
 * Returns null if the process fails or times out.
 */
export async function probeVersion(
  command: string,
  versionArgs: string[] = ["--version"],
): Promise<string | null> {
  const res = await runCommand({ command, args: versionArgs });
  if (res.timedOut) return null;
  const combined = (res.stdout + res.stderr).trim();
  if (combined.length === 0) return null;
  if (res.code !== 0) {
    // Some CLIs print version to stderr but exit non-zero; check both streams
    return combined.split(/\r?\n/)[0]?.trim() ?? null;
  }
  // First non-empty line is the version
  const line = combined.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim() ?? null;
}
