import { RuntimeSessionError } from "./errors.js";
import { DefaultRun, type AgentRun } from "./run.js";
import { silentLogger, type RuntimeLogger } from "../definition/logger.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ReasoningOptions } from "../definition/reasoning.js";
import type { PromptContent } from "../definition/content.js";
import { splitPromptContent } from "../definition/content.js";
import type { ImageInput } from "../definition/image.js";
import type { McpServer } from "../definition/mcp.js";
import type { HistoryOptions, TranscriptEntry } from "../definition/transcript.js";
import { assertPromptWithinHardBudget } from "../definition/prompt.js";
import { IdleReaper } from "./idle-reaper.js";
import { trackSession } from "./session-tracker.js";

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
   * `RuntimeSessionError` (never silently cancels it) — drain the first
   * run's `done` event (or await its `result()` / `cancel()` it), then
   * call again. The gate opens on the turn's `done`, not on process
   * exit, so back-to-back turns never stall on a lingering child.
   * With `options.queue` the second call waits instead: queued turns
   * dispatch FIFO once the previous turn's `done` is observed (drained) —
   * an undrained predecessor stalls the queue until `close()` flushes it
   * (see `SessionRunOptions.queue`).
   */
  run(prompt: PromptContent, options?: SessionRunOptions): Promise<AgentRun>;
  /**
   * Stop the active turn (terminal `done`). Queued turns survive a
   * `cancel()` — they were never started. `close()` drops them.
   */
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
  /**
   * Stall watchdog: fire when no event arrives for this many ms (a live
   * but silent agent — distinct from `timeout`, which caps total turn
   * time). Emits `error{code:"STALL"}` and cancels the run.
   * Undefined/non-positive disables.
   */
  stallTimeoutMs?: number;
  /** Phase 26: images for this turn (path-primary, agent-agnostic). */
  images?: ImageInput[];
  /**
   * Per-run model override (falls back to the session model). Validated
   * against the primed catalog like the session model — an unknown id
   * rejects before anything spawns.
   */
  model?: string;
  /** Per-run reasoning override (falls back to the session reasoning). */
  reasoning?: ReasoningOptions;
  /**
   * Opt into mid-run input: keeps the input channel open so `run.send()`
   * can append follow-up text while the turn is in flight. Runtimes with
   * no `send()` channel (opencode, claude, codex) reject this flag loudly.
   */
  allowMidRunInput?: boolean;
  /**
   * Queue behind the active run instead of rejecting when one is in flight.
   * Queued turns dispatch FIFO once the previous turn's `done` is OBSERVED
   * (drained by the consumer or a background pump — same drain requirement
   * as the gate, queue only decouples *issue* time from *drain* time). The
   * returned promise resolves with the run once it starts. Default false
   * preserves the loud-reject gate. Queued prompts live in memory only
   * (never journaled — see `run-journal.ts`), so a host crash drops the
   * queue while completed turns survive; `close()` rejects everything
   * still pending.
   */
  queue?: boolean;
  /**
   * Abort a queued entry before it starts (no effect once dispatched —
   * cancel the live run instead). Standard `AbortSignal`; structural type
   * so no DOM lib is required.
   */
  signal?: QueueAbortSignal;
}

/**
 * Minimal abort-signal surface (`addEventListener`/`removeEventListener` +
 * `aborted`). A platform `AbortSignal` satisfies it structurally in every
 * runtime — this alias only avoids pulling the DOM lib into `tsconfig`.
 */
export interface QueueAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface SessionOptions {
  id?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Diagnostics sink (default silent) — forwarded to runs and transports. */
  logger?: RuntimeLogger;
  /**
   * Close the session after this many ms without activity (run start,
   * turn end, queued demand). Undefined/non-positive disables. Long turns
   * in flight re-arm instead of killing active work.
   */
  idleTimeoutMs?: number;
  /** Factory to create a Run — core stays agnostic; tests can inject echo process */
  /**
   * Factory to create a Run — core stays agnostic; tests can inject echo process.
   * May be async (e.g. ACP handshake needs round trips before the run exists).
   */
  runFactory?: (
    id: string,
    prompt: PromptContent,
    opts: SessionRunOptions,
  ) => AgentRun | Promise<AgentRun>;
}

function generateId(): string {
  // Simple stable id — Phase 15 will sync with adapter-returned session id
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** One parked turn: prompt + options captured at enqueue, settled at dispatch. */
interface QueuedTurn {
  prompt: PromptContent;
  options: SessionRunOptions;
  signal: QueueAbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (run: AgentRun) => void;
  reject: (err: unknown) => void;
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
  protected readonly log: RuntimeLogger;
  /**
   * FIFO of turns waiting for the active run to finish. In-memory only:
   * prompts are never journaled (the journal holds turn *events*, never
   * raw queued prompts), so a host crash drops the queue while completed
   * turns survive — documented on `SessionRunOptions.queue`, not hidden.
   */
  private readonly queue: QueuedTurn[] = [];
  private dispatchActive = false;
  private readonly reaper: IdleReaper;

  public constructor(options: SessionOptions & { mcpServers?: McpServer[] } = {}) {
    this.id = options.id ?? generateId();
    this.mcpServers = options.mcpServers;
    this.cwd = options.cwd;
    this.env = options.env;
    this.runFactory = options.runFactory;
    this.log = options.logger ?? silentLogger;
    this.reaper = new IdleReaper(
      options.idleTimeoutMs,
      () => !this.hasActiveRun(),
      () => this.close(),
      this.log,
    );
    // Arm at birth: a session with no runs yet is already idle.
    this.reaper.activity();
    trackSession(this);
  }

  /** True while a run is started but its turn hasn't ended. */
  public hasActiveRun(): boolean {
    return this.currentRun !== null && !this.currentRun.done;
  }

  public async run(prompt: PromptContent, options?: SessionRunOptions): Promise<AgentRun> {
    if (this.closed) {
      throw new RuntimeSessionError(`Session ${this.id} is closed`);
    }
    assertPromptWithinHardBudget(splitPromptContent(prompt).text);
    // One active Run at a time: never silently cancel the previous one —
    // reject loudly so no turn is lost without the caller knowing —
    // unless the caller asked to queue behind it.
    if (this.currentRun && !this.currentRun.done) {
      if (options?.queue === true) {
        // Narrowed: `queue: true` implies options is defined.
        return this.enqueue(prompt, options);
      }
      throw new RuntimeSessionError(
        `Session ${this.id} already has an active run (${this.currentRun.id}) — ` +
          `drain its done event (or await its result() / cancel() it) before starting another`,
        { runtime: "session" },
      );
    }
    return this.startRun(prompt, options ?? {});
  }

  /**
   * Create and start one run immediately. The caller guarantees no active
   * run (or a finished one) — `run()` for the gate, `dispatchQueued()` for
   * the queue.
   */
  private async startRun(prompt: PromptContent, options: SessionRunOptions): Promise<AgentRun> {
    if (this.closed) {
      throw new RuntimeSessionError(`Session ${this.id} is closed`);
    }
    this.reaper.activity();
    const runId = `${this.id}:run${String(++this.runCounter)}`;
    let run: AgentRun;

    if (this.runFactory) {
      run = await this.runFactory(runId, prompt, options);
    } else {
      // Core stub: spawn a portable no-op process that consumes prompt via stdin.
      // Real adapters (runtimes/opencode) will inject their own factory with buildArgs().
      // Image parts have no delivery channel in the stub and are dropped (test-only path).
      const stdinData = splitPromptContent(prompt).text;
      run = new DefaultRun(runId, {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(0))",
        ],
        cwd: this.cwd,
        env: this.env,
        stdinData,
        timeout: options.timeout,
        stallTimeoutMs: options.stallTimeoutMs,
        logger: this.log,
        journalSessionId: this.id,
      });
    }

    // Spawn immediately for lifecycle coverage; adapter will do same via Transport
    if (run instanceof DefaultRun) {
      run.spawn();
    }

    this.observeTurnEnd(run);
    this.currentRun = run;
    this.runs.push(run);
    return run;
  }

  /**
   * Watch a run for turn end without consuming its stream: the tap yields
   * every event through untouched and nudges the queue on `done`.
   * Deliberately the ONLY dispatch trigger (no `result()` backup): the tap
   * fires exactly when `done` is observed, so the adapter resume guard
   * always sees settled state. A backup could fire mid-drain and reject a
   * waiter the tap was about to save — flaky by construction. Consequence,
   * stated loudly: queued turns dispatch when the predecessor's `done` is
   * observed (drained by anyone — consumer or background pump). An
   * undrained predecessor stalls the queue until `close()` flushes it.
   */
  private observeTurnEnd(run: AgentRun): void {
    const dispatch = (): void => {
      this.dispatchQueued();
    };
    const noteActivity = (): void => {
      this.reaper.activity();
    };
    // Pre-tap doubles may lack events() entirely (the core-agnostic
    // contract tolerates them — see "runFactory injection stays
    // core-agnostic"). Without an observable stream there is nothing to
    // tap; such runs simply never trigger dispatch.
    const eventsFn: unknown = (run as { events?: unknown }).events;
    if (typeof eventsFn !== "function") return;
    const source = (eventsFn as () => AsyncIterable<RuntimeEvent>).bind(run);
    run.events = () => {
      return (async function* (): AsyncGenerator<RuntimeEvent> {
        for await (const e of source()) {
          if (e.type === "done") {
            dispatch();
            noteActivity();
          }
          yield e;
        }
      })();
    };
  }

  /**
   * Park a turn behind the active run. Resolves with the run once it
   * starts (FIFO). Validation already ran at enqueue time, so dispatch
   * failures are factory/start faults — loud, per-waiter, never wedging
   * the queue.
   */
  private enqueue(prompt: PromptContent, options: SessionRunOptions): Promise<AgentRun> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new RuntimeSessionError(`Session ${this.id}: queued turn aborted before dispatch`, {
          runtime: "session",
        }),
      );
    }
    return new Promise<AgentRun>((resolve, reject) => {
      const entry: QueuedTurn = { prompt, options, signal, onAbort: null, resolve, reject };
      if (signal) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return; // Already dispatched — abort only dequeues.
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          entry.onAbort = null;
          this.log.debug("dequeue", { sessionId: this.id });
          reject(
            new RuntimeSessionError(`Session ${this.id}: queued turn aborted before dispatch`, {
              runtime: "session",
            }),
          );
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(entry);
      this.log.debug("enqueue", { sessionId: this.id, depth: this.queue.length });
      this.reaper.activity();
    });
  }

  /**
   * Start the next queued turn when the session is idle. Reentrancy-guarded;
   * a poison entry rejects its waiter and the queue moves on.
   */
  private dispatchQueued(): void {
    if (this.dispatchActive || this.closed) return;
    if (this.currentRun && !this.currentRun.done) return;
    const next = this.queue.shift();
    if (!next) return;
    this.dispatchActive = true;
    void this.startQueued(next);
  }

  private async startQueued(next: QueuedTurn): Promise<void> {
    try {
      if (next.signal?.aborted) {
        throw new RuntimeSessionError(`Session ${this.id}: queued turn aborted before dispatch`, {
          runtime: "session",
        });
      }
      const run = await this.startRun(next.prompt, next.options);
      next.resolve(run);
    } catch (err) {
      next.reject(err);
    } finally {
      if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
      next.onAbort = null;
      this.dispatchActive = false;
      this.dispatchQueued();
    }
  }

  /** Reject everything still queued (close path). Started runs are untouched. */
  private dropQueue(): void {
    if (this.queue.length > 0) {
      // A stalled-then-flushed queue is a drained-never predecessor away
      // from silent misuse — say so loudly in ops.
      this.log.warn("queue-flushed", { sessionId: this.id, depth: this.queue.length });
    }
    for (const entry of this.queue.splice(0)) {
      if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
      entry.reject(
        new RuntimeSessionError(
          `Session ${this.id} is closed — queued turn dropped before dispatch`,
          {
            runtime: "session",
          },
        ),
      );
    }
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
    this.reaper.stop();
    this.dropQueue();
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
