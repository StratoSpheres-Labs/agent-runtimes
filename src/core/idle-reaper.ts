import { silentLogger, type RuntimeLogger } from "../definition/logger.js";

/**
 * IdleReaper — closes an idle session after `timeoutMs` without activity.
 * Activity = run start, turn end, or queued demand (callers invoke
 * `activity()` at those points). A firing reaper re-checks idleness first:
 * a long turn in flight re-arms instead of killing active work. Disabled
 * when `timeoutMs` is undefined or non-positive. Timers are unref'd
 * (cross-platform rule — a reaper never keeps the host alive).
 */
export class IdleReaper {
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly timeoutMs: number | undefined,
    private readonly isIdle: () => boolean,
    private readonly onIdle: () => void | Promise<void>,
    private readonly log: RuntimeLogger = silentLogger,
  ) {}

  /** Record activity; (re)arms the timer. No-op when disabled. */
  public activity(): void {
    if (this.timeoutMs === undefined || this.timeoutMs <= 0) return;
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isIdle()) {
        // Busy (a turn outlived the timeout) — not idle, re-arm and
        // re-check later instead of killing live work.
        this.activity();
        return;
      }
      this.log.debug("idle-reap");
      void Promise.resolve()
        .then(() => this.onIdle())
        .catch((err: unknown) => {
          this.log.warn("idle-close-failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }, this.timeoutMs);
    this.timer.unref();
  }

  /** Disarm (session close). */
  public stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
