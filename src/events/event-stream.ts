import type { RuntimeEvent } from "./runtime-event.js";

/**
 * Cap on queued (undrained) events. A live consumer drains as fast as
 * events arrive, so the queue only grows when nobody is reading — exactly
 * the runaway case (flooding agent, stalled UI). Generous for legit turns
 * (thousands of deltas), fatal for floods only via the drop below.
 */
export const MAX_STREAM_QUEUE_LENGTH = 10_000;

/**
 * Simple push/close async iterable for RuntimeEvent.
 * Used by Run → consumer; the queue is bounded (v0.1+): overflow drops
 * data events with a single BUFFER_OVERFLOW error, `done` always flows.
 */
export class EventStream implements AsyncIterable<RuntimeEvent> {
  private queue: RuntimeEvent[] = [];
  private resolvers: Array<(v: IteratorResult<RuntimeEvent>) => void> = [];
  private closed = false;
  private error: unknown = null;
  private droppedTotal = 0;
  private overflowNotified = false;

  public push(event: RuntimeEvent): void {
    if (this.closed) return;
    // Termination is sacred: `done` always flows so runs can never hang
    // past the cap. Everything else (including `error` diagnostics) is
    // expendable under flood — the single BUFFER_OVERFLOW error below is
    // the diagnostic that survives.
    if (event.type !== "done" && this.queue.length >= MAX_STREAM_QUEUE_LENGTH) {
      this.droppedTotal++;
      if (!this.overflowNotified) {
        this.overflowNotified = true;
        this.enqueue({
          type: "error",
          error: {
            code: "BUFFER_OVERFLOW",
            message: `Event stream overflow: queue exceeded ${String(MAX_STREAM_QUEUE_LENGTH)} events — dropping data events until drained`,
            cause: { dropped: this.droppedTotal },
          },
        });
      }
      return;
    }
    this.enqueue(event);
  }

  /** Direct enqueue (bypasses the cap — for `done` and the overflow signal). */
  private enqueue(event: RuntimeEvent): void {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      resolve?.({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  public fail(err: unknown): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    // Wake any pending iterator so it can throw `this.error`
    for (const r of this.resolvers.splice(0)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      r({ value: undefined as unknown as RuntimeEvent, done: true });
    }
    this.resolvers = [];
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers.splice(0)) {
      // done=true allows value to be undefined; cast keeps types happy
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      r({ value: undefined as unknown as RuntimeEvent, done: true });
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      if (this.queue.length > 0) {
        const ev = this.queue.shift();
        if (ev) yield ev;
        continue;
      }
      if (this.closed) {
        if (this.error) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw this.error;
        }
        return;
      }
      const next = await new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
