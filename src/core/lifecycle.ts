import { spawn, type ChildProcess } from "node:child_process";
import { RuntimeSpawnError, RuntimeTimeoutError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types — Dev_Docs Tasks 3.2 / 3.3
// ---------------------------------------------------------------------------

export type ProcessState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Extra env vars to merge; never blindly forward process.env in prod (AGENTS.md:9) */
  env?: Record<string, string | undefined>;
  /** Optional timeout in ms — triggers kill + RuntimeTimeoutError */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// RuntimeProcess — manages a single ChildProcess lifecycle (Task 3.1)
// ---------------------------------------------------------------------------

export class RuntimeProcess {
  public state: ProcessState = "starting";
  private child: ChildProcess | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private lastExit: ProcessExit | null = null;
  /** Settles with the process exit; REJECTS on spawn error or timeout (wait()) */
  private exitPromise: Promise<ProcessExit> | null = null;
  private exitResolve: ((e: ProcessExit) => void) | null = null;
  private exitReject: ((e: Error) => void) | null = null;
  /** Settles only on the close event (never rejects) — used by kill()/cancel() */
  private closePromise: Promise<ProcessExit> | null = null;
  private closeResolve: ((e: ProcessExit) => void) | null = null;
  private readonly options: SpawnOptions;

  public constructor(options: SpawnOptions) {
    this.options = options;
  }

  // ---- public getters ----

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public get stdout(): NodeJS.ReadableStream | null {
    return this.child?.stdout ?? null;
  }

  public get stderr(): NodeJS.ReadableStream | null {
    return this.child?.stderr ?? null;
  }

  public get stdin(): NodeJS.WritableStream | null {
    return this.child?.stdin ?? null;
  }

  // ---- spawn ----

  public spawn(): void {
    if (this.child) {
      throw new RuntimeSpawnError("Process already spawned", {
        command: this.options.command,
      });
    }

    let child: ChildProcess;
    try {
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        env: this.options.env as unknown as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      const cause = err as Error;
      // EINVAL/ENOENT surface synchronously here (e.g. a .cmd shim on
      // Windows, which CreateProcess cannot execute). Convert to a
      // diagnosable rejection instead of a raw host crash.
      const shimHint =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(this.options.command)
          ? " On Windows, .cmd/.bat shims cannot be spawned directly (shell:false); configure the native .exe instead (see docs/cross-platform.md §1)."
          : "";
      throw new RuntimeSpawnError(
        `Failed to spawn "${this.options.command}": ${cause.message}.${shimHint}`,
        { command: this.options.command, cwd: this.options.cwd },
        { cause },
      );
    }

    this.child = child;
    this.state = "running";
    this.exitPromise = new Promise<ProcessExit>((resolve, reject) => {
      this.exitResolve = resolve;
      this.exitReject = reject;
    });
    this.closePromise = new Promise<ProcessExit>((resolve) => {
      this.closeResolve = resolve;
    });

    child.on("error", (err: Error) => {
      this.state = "failed";
      this.clearTimer();
      this.closeResolve?.({ code: null, signal: null });
      this.exitReject?.(
        new RuntimeSpawnError(err.message, { command: this.options.command }, { cause: err }),
      );
    });

    child.on("close", (code, signal) => {
      this.clearTimer();
      if (this.state === "stopping") {
        this.state = "stopped";
      } else if (this.state === "failed") {
        // already set
      } else if (code === 0) {
        this.state = "stopped";
      } else {
        this.state = "failed";
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const exit: ProcessExit = { code, signal: signal as unknown as NodeJS.Signals | null };
      this.lastExit = exit;
      this.closeResolve?.(exit);
      this.exitResolve?.(exit);
    });

    if (this.options.timeout != null && this.options.timeout > 0) {
      this.timeoutTimer = setTimeout(() => {
        void this.timeout();
      }, this.options.timeout);
      this.timeoutTimer.unref();
    }
  }

  // ---- write to stdin ----

  public async write(data: string | Uint8Array): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) {
      throw new RuntimeSpawnError("Process stdin not available", {
        command: this.options.command,
      });
    }
    return new Promise((resolve, reject) => {
      const ok = stdin.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!ok) {
        stdin.once("drain", () => {
          resolve();
        });
      }
    });
  }

  public endStdin(): void {
    this.child?.stdin?.end();
  }

  // ---- cancellation — Task 3.4 ----

  public async cancel(signal: NodeJS.Signals = "SIGTERM"): Promise<ProcessExit> {
    if (!this.child || this.state === "stopped" || this.state === "failed") {
      // Already done — return last known exit (never the rejected wait promise)
      return this.lastExit ?? { code: null, signal: null };
    }
    this.state = "stopping";
    return this.kill(signal);
  }

  private async timeout(): Promise<void> {
    if (this.state !== "running" && this.state !== "starting") return;
    this.state = "stopping";
    // 1) Reject wait() immediately so RuntimeTimeoutError reaches the caller
    this.exitReject?.(
      new RuntimeTimeoutError(`Process timed out after ${String(this.options.timeout)}ms`, {
        command: this.options.command,
      }),
    );
    // 2) Ensure the OS process is actually killed (fire-and-forget; uses closePromise)
    await this.kill("SIGTERM");
  }

  private async kill(signal: NodeJS.Signals): Promise<ProcessExit> {
    if (!this.child) return this.lastExit ?? { code: null, signal: null };
    const child = this.child;

    try {
      child.kill(signal);
    } catch {
      // kill may throw if already exited
    }

    // Wait for close, with a hard grace then SIGKILL fallback
    const fallback = new Promise<ProcessExit>((resolve) => {
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        const hard = setTimeout(() => {
          resolve({ code: child.exitCode, signal: child.signalCode });
        }, 1000);
        hard.unref();
      }, 1000);
      grace.unref();
    });

    const exit = await Promise.race([this.closePromise ?? fallback, fallback]);
    return exit;
  }

  // ---- close — Task 3.4 full cleanup ----

  public async close(signal: NodeJS.Signals = "SIGTERM"): Promise<ProcessExit> {
    this.clearTimer();
    const exit = await this.cancel(signal);
    this.cleanup();
    return exit;
  }

  private cleanup(): void {
    this.clearTimer();
    if (this.child) {
      this.child.stdout?.removeAllListeners();
      this.child.stderr?.removeAllListeners();
      this.child.stdin?.removeAllListeners();
      this.child.removeAllListeners();
      try {
        this.child.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        this.child.stderr?.destroy();
      } catch {
        // ignore
      }
      try {
        if (!this.child.stdin?.destroyed) this.child.stdin?.destroy();
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.state = "stopped";
  }

  private clearTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  // ---- wait ----

  public async wait(): Promise<ProcessExit> {
    if (!this.exitPromise) {
      throw new RuntimeSpawnError("Process not spawned", {
        command: this.options.command,
      });
    }
    return this.exitPromise;
  }
}
