import { RuntimeProcess, type ProcessExit } from "./lifecycle.js";
import { RuntimeSessionError } from "./errors.js";
import { EventStream } from "../events/event-stream.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { RuntimeParser } from "../parser/parser.js";

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
  /** Cancel this run's underlying process */
  cancel(): Promise<void>;
  /** Wait for process exit */
  result(): Promise<ProcessExit>;
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
  private readonly keepStdinOpen: boolean;
  private readonly stream = new EventStream();
  private sawDone = false;

  public constructor(id: string, options: RunOptions) {
    this.id = id;
    this.stdinData = options.stdinData;
    this.parser = options.parser;
    this.keepStdinOpen = options.keepStdinOpen ?? false;
    this.process = new RuntimeProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
    });
  }

  public get done(): boolean {
    return this._done;
  }

  public get pid(): number | undefined {
    return this.process.pid;
  }

  public events(): AsyncIterable<RuntimeEvent> {
    return this.stream;
  }

  /** Spawn the underlying process and wire stdout → RuntimeEvent */
  public spawn(): void {
    this.process.spawn();

    const stdout = this.process.stdout;
    if (stdout) {
      if (this.parser) {
        const parser = this.parser;
        // Parser mode: raw bytes → parser → RuntimeEvent
        stdout.on("data", (chunk: Buffer) => {
          const events = parser.parse(new Uint8Array(chunk));
          for (const e of events) {
            if (e.type === "done") this.sawDone = true;
            this.stream.push(e);
          }
        });
      } else {
        // Raw mode: chunks → text_delta
        stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          if (text.length > 0) {
            this.stream.push({ type: "text_delta", text });
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
            this.stream.push({
              type: "error",
              error: { code: "STDERR", message: text },
            });
          }
        });
      }
    }

    if (this.stdinData !== undefined) {
      void this.process.write(this.stdinData).then(() => {
        if (!this.keepStdinOpen) this.process.endStdin();
      });
    } else if (!this.keepStdinOpen) {
      this.process.endStdin();
    }

    void this.process.wait().then(
      (exit) => {
        this._done = true;
        if (this.parser) {
          const parser = this.parser;
          // Flush any buffered partial
          for (const e of parser.flush()) {
            if (e.type === "done") this.sawDone = true;
            this.stream.push(e);
          }
          if (!this.sawDone) {
            if (exit.code !== 0 && exit.code !== null) {
              this.stream.push({
                type: "error",
                error: {
                  code: "NON_ZERO_EXIT",
                  message: `Process exited with code ${String(exit.code)}`,
                },
              });
            }
            this.stream.push({ type: "done", exitCode: exit.code, signal: exit.signal });
          }
        } else {
          if (exit.code !== 0 && exit.code !== null) {
            this.stream.push({
              type: "error",
              error: {
                code: "NON_ZERO_EXIT",
                message: `Process exited with code ${String(exit.code)}`,
              },
            });
          }
          this.stream.push({ type: "done", exitCode: exit.code, signal: exit.signal });
        }
        this.stream.close();
      },
      (err: unknown) => {
        this._done = true;
        const message = err instanceof Error ? err.message : String(err);
        this.stream.push({ type: "error", error: { code: "PROCESS_ERROR", message } });
        this.stream.push({ type: "done" });
        this.stream.close();
      },
    );
  }

  public async cancel(): Promise<void> {
    if (this._done) return;
    try {
      await this.process.cancel();
    } catch (err) {
      throw new RuntimeSessionError((err as Error).message, {}, { cause: err as Error });
    } finally {
      this._done = true;
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

  public async respondToPermission(id: string, optionId: string): Promise<void> {
    // Claude AskUserQuestion answer — user envelope with tool_result
    const payload =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: optionId }] },
      }) + "\n";
    await this.process.write(payload);
  }
}
