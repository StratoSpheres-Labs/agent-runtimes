import { RuntimeSessionError } from "./errors.js";
import { DefaultRun, type AgentRun } from "./run.js";
import type { ImageInput } from "../definition/image.js";
import type { McpServer } from "../definition/mcp.js";
import type { HistoryOptions, TranscriptEntry } from "../definition/transcript.js";
import { assertPromptWithinHardBudget } from "../definition/prompt.js";

/**
 * Phase 4 — Session spans multiple Processes (Session !== Process).
 * Each `run()` creates a new AgentRun with its own RuntimeProcess.
 */

export interface AgentSession {
  readonly id: string;
  /** Phase 33: servers attached to this session (what was passed at createSession). */
  readonly mcpServers?: McpServer[];
  /**
   * Start one turn. At most one Run is active per session: a second `run()`
   * while the previous one is still going rejects with
   * `RuntimeSessionError` (never silently cancels it) — await the first
   * run's `result()` or `cancel()` it explicitly, then call again.
   */
  run(prompt: string, options?: SessionRunOptions): Promise<AgentRun>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  /**
   * Compact conversation history (read-only, never persisted by the
   * library). Optional: sessions without a transcript store return [].
   * Entries may contain user-pasted secrets — never log them blindly.
   */
  history?(options?: HistoryOptions): Promise<TranscriptEntry[]>;
  /** Phase 15: resume this session (no-op for core stub, adapter overrides) */
  resume(): Promise<void>;
}

export interface SessionRunOptions {
  timeout?: number;
  /** Phase 26: images for this turn (path-primary, agent-agnostic). */
  images?: ImageInput[];
}

export interface SessionOptions {
  id?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Factory to create a Run — core stays agnostic; tests can inject echo process */
  /**
   * Factory to create a Run — core stays agnostic; tests can inject echo process.
   * May be async (e.g. ACP handshake needs round trips before the run exists).
   */
  runFactory?: (
    id: string,
    prompt: string,
    opts: SessionRunOptions,
  ) => AgentRun | Promise<AgentRun>;
}

function generateId(): string {
  // Simple stable id — Phase 15 will sync with adapter-returned session id
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class DefaultSession implements AgentSession {
  public readonly id: string;
  public readonly mcpServers?: McpServer[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly runFactory: SessionOptions["runFactory"];
  private runs: AgentRun[] = [];
  private currentRun: AgentRun | null = null;
  private closed = false;
  private runCounter = 0;

  public constructor(options: SessionOptions & { mcpServers?: McpServer[] } = {}) {
    this.id = options.id ?? generateId();
    this.mcpServers = options.mcpServers;
    this.cwd = options.cwd;
    this.env = options.env;
    this.runFactory = options.runFactory;
  }

  public async run(prompt: string, options?: SessionRunOptions): Promise<AgentRun> {
    if (this.closed) {
      throw new RuntimeSessionError(`Session ${this.id} is closed`);
    }
    assertPromptWithinHardBudget(prompt);
    // One active Run at a time: never silently cancel the previous one —
    // reject loudly so no turn is lost without the caller knowing.
    if (this.currentRun && !this.currentRun.done) {
      throw new RuntimeSessionError(
        `Session ${this.id} already has an active run (${this.currentRun.id}) — ` +
          `await its result() or cancel() it before starting another`,
        { runtime: "session" },
      );
    }

    const runId = `${this.id}:run${String(++this.runCounter)}`;
    let run: AgentRun;

    if (this.runFactory) {
      run = await this.runFactory(runId, prompt, options ?? {});
    } else {
      // Core stub: spawn a portable no-op process that consumes prompt via stdin.
      // Real adapters (runtimes/opencode) will inject their own factory with buildArgs().
      const stdinData = prompt;
      run = new DefaultRun(runId, {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(0))",
        ],
        cwd: this.cwd,
        env: this.env,
        stdinData,
        timeout: options?.timeout,
      });
    }

    // Spawn immediately for lifecycle coverage; adapter will do same via Transport
    if (run instanceof DefaultRun) {
      run.spawn();
    }

    this.currentRun = run;
    this.runs.push(run);
    return run;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async history(): Promise<TranscriptEntry[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async resume(): Promise<void> {
    if (this.closed) {
      throw new RuntimeSessionError(`Session ${this.id} is closed`);
    }
    // Core stub is a no-op (each run is already a new Process with same id).
    // Adapters (e.g. opencode) override to capture native session id.
  }

  public async cancel(): Promise<void> {
    if (this.currentRun && !this.currentRun.done) {
      await this.currentRun.cancel();
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentRun && !this.currentRun.done) {
      await this.currentRun.cancel();
    }
    // Ensure all runs cleaned
    await Promise.all(
      this.runs.map((r) =>
        r.close().catch(() => {
          // ignore cleanup errors
        }),
      ),
    );
    this.runs = [];
    this.currentRun = null;
  }
}
