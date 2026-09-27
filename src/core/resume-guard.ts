import { RuntimeSessionError } from "./errors.js";

/**
 * Native-id resume guard — shared by the opencode/claude/codex sessions.
 *
 * The native session id is captured by each session's events wrapper, so it
 * only exists when the caller drains the previous run. Starting a new run
 * without it would silently open a FRESH upstream session (context lost),
 * so the guard fails loudly instead. Agent-agnostic (Rule 7): the id is an
 * opaque presence bit — no runtime branches, no CLI knowledge.
 *
 * Correctness note: `idlessDrainComplete` is set only when the latest run
 * drained to `done` with no id anywhere in its stream. In-order delivery
 * means no earlier `session_started` could have been missed, so a fresh
 * start is provably safe in exactly that case.
 */
export class NativeIdResumeGuard {
  private runsCreated = 0;
  private idlessDrainComplete = false;

  /** Call from the session's run factory (once per created run). */
  public noteRunCreated(): void {
    this.runsCreated++;
    this.idlessDrainComplete = false;
  }

  /**
   * Call from the session's events wrapper for every event. `hasId`
   * reports whether the session's native id is known at that moment.
   */
  public noteEvent(type: string, hasId: boolean): void {
    if (type === "done" && !hasId) {
      this.idlessDrainComplete = true;
    }
  }

  /**
   * Call from `run()` before delegating. Throws when a previous run exists
   * but its native id is unknown and unrecoverable (stream never drained).
   * `nativeId` is the session's current id (null when unknown);
   * `sessionId`/`runtime` only label the error.
   */
  public assertCanStartRun(
    nativeId: string | null,
    sessionId: string,
    runtime: string,
    threadNoun = "session",
  ): void {
    if (nativeId === null && this.runsCreated >= 1 && !this.idlessDrainComplete) {
      throw new RuntimeSessionError(
        `Session ${sessionId}: cannot start a new run — the previous run's native id was never captured (its event stream was not drained to done), so resuming would silently open a fresh upstream ${threadNoun} and lose context. Drain the previous run's events to done first, or create a fresh session.`,
        { runtime },
      );
    }
  }
}
