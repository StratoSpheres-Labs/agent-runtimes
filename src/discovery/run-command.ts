import { spawn } from "node:child_process";

export interface RunCommandOptions {
  command: string;
  args?: string[];
  /**
   * Spawn env (replaces — never merges). Omit to inherit ambient (config
   * lookup needs HOME/PATH). When a shim needs extras, merge explicitly
   * (`{ ...process.env, ...extras }`) — never pass extras alone.
   */
  env?: Record<string, string | undefined>;
  /**
   * Timeout in ms. On timeout the child is SIGTERM'd (then SIGKILL'd after
   * a 1s grace) and the result is marked `timedOut`. Default 10_000.
   * Non-positive values disable the timeout (not recommended for probes).
   */
  timeout?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;

/**
 * Run a short-lived probe command and collect its output.
 * Always settles — never a hanging promise:
 *  - spawn error  → `{ code: null, timedOut: false }`
 *  - timeout      → child killed, `{ code: null, timedOut: true }`
 *  - close        → `{ code, signal, timedOut: false }`
 */
export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { command, args = [], env, timeout = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (result: RunCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        ...(env === undefined ? {} : { env }),
      });
    } catch {
      settle({ stdout: "", stderr: "", code: null, signal: null, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already exited
        }
        const hard = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
        }, KILL_GRACE_MS);
        hard.unref();
        settle({ stdout, stderr, code: null, signal: null, timedOut: true });
      }, timeout);
      timer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", () => {
      settle({ stdout, stderr, code: null, signal: null, timedOut: false });
    });
    child.on("close", (code, signal) => {
      settle({ stdout, stderr, code, signal, timedOut: false });
    });
  });
}
