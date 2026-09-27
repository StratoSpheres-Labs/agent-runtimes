import { RuntimeProcess, type ProcessExit } from "./lifecycle.js";
import { RuntimeSessionError, RuntimeTimeoutError } from "./errors.js";
import { EventStream } from "../events/event-stream.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { RuntimeParser } from "../parser/parser.js";
import type { PromptContent } from "../definition/content.js";

/**
 * Phase 5/6 — Run with unified RuntimeEvent stream.
 * Supports two modes:
 *  - Raw (no parser): stdout chunks → text_delta
 *  - Parser: stdout bytes → RuntimeParser → RuntimeEvent
 */
export interface AgentRun {
  readonly id: string;
  /** Async stream of unified events — only RuntimeEvent ever leaks */
  events(): AsyncIterable<RuntimeEvent>;
  /**
   * Cancel this run's underlying process. Always ends the event stream
   * with a terminal `done` (carrying the kill signal) — `close()` alone
   * is silent teardown and emits nothing.
   */
  cancel(): Promise<void>;
  /** Wait for process exit */
  result(): Promise<ProcessExit>;
  /**
   * Append follow-up input while the turn is in flight (steering). Only
   * available on runs started with `allowMidRunInput` on runtimes whose
   * capability `midRunInput` is true (ACP `session/prompt`) — the base
   * throws, adapters override the slot. Delivery is guaranteed; whether
   * the agent interleaves the input mid-turn is agent-defined.
   */
  send?(input: PromptContent): Promise<void>;
  /** Cleanup after run — idempotent */
  close(): Promise<void>;
  /** Whether the run has completed */
  readonly done: boolean;
  /** Phase 29: answer a permission_request (Claude AskUserQuestion / ACP). */
  respondToPermission?(id: string, optionId: string): Promise<void>;
}

export interface RunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Prompt to pipe via stdin when input type is stdin */
  stdinData?: string;
  timeout?: number;
  /** Optional parser — when provided, stdout is decoded via parser (Phase 7/8) */
  parser?: RuntimeParser;
  /** Phase 29: keep stdin open for interactive permission responses (Claude AskUserQuestion). */
  keepStdinOpen?: boolean;
}

export class DefaultRun implements AgentRun {
  public readonly id: string;
  private readonly process: RuntimeProcess;
  private _done = false;
  private readonly stdinData: string | undefined;
  private readonly parser: RuntimeParser | undefined;
  protected readonly keepStdinOpen: boolean;
  protected readonly runCwd: string | undefined;
  private readonly runCommand: string;
  private readonly stream = new EventStream();
  private sawDone = false;

  public constructor(id: string, options: RunOptions) {
    this.id = id;
    this.stdinData = options.stdinData;
    this.parser = options.parser;
    this.keepStdinOpen = options.keepStdinOpen ?? false;
    this.runCwd = options.cwd;
    this.runCommand = options.command;
    this.process = new RuntimeProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
    });
  }

  public get done(): boolean {
    // Turn-over, not process-reaped: the session gate must open as soon as
    // the parser emits `done`, even if the child lingers in teardown (slow
    // exits made back-to-back runs spuriously reject). Lifecycle methods
    // below keep using the `_done` field, so cancel()/close() still reap
    // lingering processes.
    return this._done || this.sawDone;
  }

  public get pid(): number | undefined {
    return this.process.pid;
  }

  public events(): AsyncIterable<RuntimeEvent> {
    return this.stream;
  }

  /**
   * Stamp every emitted event with this Run's id (`<sessionId>:run<N>`).
   * Parser output arrives unstamped (Rule 4); an explicitly set runId is
   * never overwritten.
   */
  private push(event: RuntimeEvent): void {
    if (event.runId === undefined) event.runId = this.id;
    this.stream.push(event);
  }

  /** Spawn the underlying process and wire stdout → RuntimeEvent */
  public spawn(): void {
    this.process.spawn();

    const stdout = this.process.stdout;
    if (stdout) {
      if (this.parser) {
        const parser = this.parser;
        // Parser mode: raw bytes → parser → RuntimeEvent. A throwing
        // parser must never take down the host (EventEmitter would turn it
        // into an uncaughtException) — convert to an error event instead.
        stdout.on("data", (chunk: Buffer) => {
          let events: RuntimeEvent[];
          try {
            events = parser.parse(new Uint8Array(chunk));
          } catch (err) {
            this.push({
              type: "error",
              error: {
                code: "PARSER_ERROR",
                message: err instanceof Error ? err.message : String(err),
              },
            });
            return;
          }
          for (const e of events) {
            if (e.type === "done") this.sawDone = true;
            this.push(e);
          }
        });
      } else {
        // Raw mode: chunks → text_delta
        stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          if (text.length > 0) {
            this.push({ type: "text_delta", text });
          }
        });
      }
    }

    // Parser mode ignores stderr (opencode logs non-JSON there); raw mode surfaces it
    if (!this.parser) {
      const stderr = this.process.stderr;
      if (stderr) {
        stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8").trim();
          if (text.length > 0) {
            this.push({
              type: "error",
              error: { code: "STDERR", message: text },
            });
          }
        });
      }
    }

    if (this.stdinData !== undefined) {
      // The rejection handler matters: without it an early-exiting agent
      // (EPIPE on write) becomes an unhandled rejection and kills the host.
      void this.process.write(this.stdinData).then(
        () => {
          if (!this.keepStdinOpen) this.process.endStdin();
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.push({
            type: "error",
            error: { code: "STDIN_WRITE_FAILED", message },
          });
        },
      );
    } else if (!this.keepStdinOpen) {
      this.process.endStdin();
    }

    void this.process.wait().then(
      (exit) => {
        this._done = true;
        if (this.parser) {
          const parser = this.parser;
          // Flush any buffered partial (guarded: a throw here would land in
          // a voided promise as an unhandled rejection and kill the host).
          let flushed: RuntimeEvent[];
          try {
            flushed = parser.flush();
          } catch (err) {
            flushed = [];
            this.push({
              type: "error",
              error: {
                code: "PARSER_ERROR",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
          for (const e of flushed) {
            if (e.type === "done") this.sawDone = true;
            this.push(e);
          }
          if (!this.sawDone) {
            if (exit.code !== 0 && exit.code !== null) {
              this.push({
                type: "error",
                error: {
                  code: "NON_ZERO_EXIT",
                  message: `Process exited with code ${String(exit.code)}`,
                },
              });
            }
            this.push({ type: "done", exitCode: exit.code, signal: exit.signal });
            this.sawDone = true;
          }
        } else {
          if (exit.code !== 0 && exit.code !== null) {
            this.push({
              type: "error",
              error: {
                code: "NON_ZERO_EXIT",
                message: `Process exited with code ${String(exit.code)}`,
              },
            });
          }
          this.push({ type: "done", exitCode: exit.code, signal: exit.signal });
          this.sawDone = true;
        }
        this.stream.close();
      },
      (err: unknown) => {
        this._done = true;
        const message = err instanceof Error ? err.message : String(err);
        // Timeouts keep their identity (ACP runs already emit TIMEOUT):
        // frontends must not string-match messages to tell "too slow"
        // apart from "crashed".
        const code = err instanceof RuntimeTimeoutError ? "TIMEOUT" : "PROCESS_ERROR";
        this.push({ type: "error", error: { code, message } });
        this.push({ type: "done" });
        this.sawDone = true;
        this.stream.close();
      },
    );
  }

  public async cancel(): Promise<void> {
    if (this._done) return;
    let exit: ProcessExit | null = null;
    try {
      exit = await this.process.cancel();
    } catch (err) {
      throw new RuntimeSessionError((err as Error).message, {}, { cause: err as Error });
    } finally {
      this._done = true;
      // Terminal event: without it consumers cannot tell "cancelled" apart
      // from "stream cut". Carries the real kill exit (SIGTERM by default).
      // Guarded by sawDone — the exit handler may have pushed the synthetic
      // done first in a cancel-vs-exit race.
      if (!this.sawDone) {
        this.sawDone = true;
        this.push({
          type: "done",
          exitCode: exit?.code ?? null,
          signal: exit?.signal ?? "SIGTERM",
        });
      }
      this.stream.close();
    }
  }

  public async result(): Promise<ProcessExit> {
    try {
      const exit = await this.process.wait();
      this._done = true;
      return exit;
    } catch (err) {
      this._done = true;
      throw err;
    }
  }

  public async close(): Promise<void> {
    await this.process.close();
    this._done = true;
    this.stream.close();
  }

  /**
   * Base `send()` always rejects: raw stdin bytes have no agreed meaning
   * across CLIs (stream-json envelopes vs. prompt text), so an adapter
   * must opt in explicitly (ClaudeRun, AcpRun). Core never guesses (Rule 6).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- intentionally synchronous: the base never touches I/O, it only rejects (adapters override with real channels)
  public async send(_input?: PromptContent): Promise<void> {
    throw new RuntimeSessionError(
      `mid-run input (send) is not supported by this run ("${this.runCommand}") — start the run with allowMidRunInput on a runtime whose midRunInput capability is true`,
      { command: this.runCommand, cwd: this.runCwd },
    );
  }

  // NOTE: no respondToPermission here — stdin answer envelopes are
  // agent-specific wire shapes (Rule 6). Adapters that support interactive
  // permission answers subclass DefaultRun (see ClaudeRun) and implement
  // the AgentRun.respondToPermission slot with their native envelope.

  /**
   * Raw stdin write for subclasses composing their native envelopes.
   * Bytes only — no agent shape is assumed here.
   */
  protected async writeStdin(data: string): Promise<void> {
    await this.process.write(data);
  }
}
