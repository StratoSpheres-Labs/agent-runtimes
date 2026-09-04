import type { RuntimeEvent } from "./runtime-event.js";

/**
 * Simple push/close async iterable for RuntimeEvent.
 * Used by Run → consumer; backpressure is bounded (v0.1).
 */
export class EventStream implements AsyncIterable<RuntimeEvent> {
  private queue: RuntimeEvent[] = [];
  private resolvers: Array<(v: IteratorResult<RuntimeEvent>) => void> = [];
  private closed = false;
  private error: unknown = null;

  public push(event: RuntimeEvent): void {
    if (this.closed) return;
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
