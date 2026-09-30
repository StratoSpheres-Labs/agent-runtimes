import { describe, expect, it } from "vitest";
import { DefaultSession } from "../src/core/session.js";
import { EventStream } from "../src/events/event-stream.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import type { AgentRun } from "../src/core/run.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import type { ProcessExit } from "../src/core/lifecycle.js";
import type { PromptContent } from "../src/definition/content.js";
import type { QueueAbortSignal, SessionRunOptions } from "../src/core/session.js";

/**
 * Controllable run double. Mirrors real completion semantics: `result()`
 * pends until the turn actually ends (like process exit / turn completion),
 * so the queue's result-backup dispatch fires post-done even when nobody
 * drains the stream — the fire-and-forget pattern under test.
 */
interface ManualRun extends AgentRun {
  finish(): void;
}

function manualRun(id: string): ManualRun {
  const stream = new EventStream();
  let done = false;
  let resolveResult: ((e: ProcessExit) => void) | null = null;
  const settled = new Promise<ProcessExit>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (): void => {
    if (done) return;
    done = true;
    stream.push({ type: "done" });
    stream.close();
    resolveResult?.({ code: 0, signal: null });
  };
  const run: ManualRun = {
    id,
    get done() {
      return done;
    },
    events: () => stream,
    // eslint-disable-next-line @typescript-eslint/require-await
    async cancel() {
      finish();
    },
    async result() {
      return settled;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async close() {
      stream.close();
    },
    finish,
  };
  return run;
}

function manualSignal(): { signal: QueueAbortSignal; abort: () => void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: QueueAbortSignal = {
    get aborted() {
      return aborted;
    },
    addEventListener(_type: "abort", listener: () => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: "abort", listener: () => void): void {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    abort: () => {
      aborted = true;
      for (const l of [...listeners]) l();
      listeners.clear();
    },
  };
}

async function drain(run: AgentRun): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of run.events()) {
    out.push(e);
    if (e.type === "done") break;
  }
  return out;
}

describe("session run queue", () => {
  it("dispatches queued turns FIFO as predecessors drain", async () => {
    const created: ManualRun[] = [];
    const session = new DefaultSession({
      runFactory: (id) => {
        const run = manualRun(id);
        created.push(run);
        return run;
      },
    });
    const r1 = (await session.run("m1")) as ManualRun;
    const p2 = session.run("m2", { queue: true });
    const p3 = session.run("m3", { queue: true });
    expect(created.map((r) => r.id)).toEqual([`${session.id}:run1`]);
    // Draining advances the tap, which dispatches the queue.
    r1.finish();
    await drain(r1);
    const r2 = (await p2) as ManualRun;
    expect(r2.id).toBe(`${session.id}:run2`);
    r2.finish();
    await drain(r2);
    const r3 = (await p3) as ManualRun;
    expect(r3.id).toBe(`${session.id}:run3`);
    expect(created).toHaveLength(3);
    r3.finish();
    await drain(r3);
    await session.close();
  });

  it("queue:true on an idle session starts immediately", async () => {
    const session = new DefaultSession();
    const run = await session.run("x", { queue: true });
    await drain(run);
    expect(run.done).toBe(true);
    await session.close();
  });

  it("a poison entry rejects its waiter but never wedges the queue", async () => {
    const session = new DefaultSession({
      runFactory: (id, prompt: PromptContent, _opts: SessionRunOptions) => {
        const text = typeof prompt === "string" ? prompt : "?";
        if (text === "bad") throw new RuntimeSessionError("poison", { runtime: "test" });
        return manualRun(id);
      },
    });
    const r1 = (await session.run("m1")) as ManualRun;
    const pBad = session.run("bad", { queue: true });
    const pGood = session.run("m3", { queue: true });
    r1.finish();
    await drain(r1);
    await expect(pBad).rejects.toThrow("poison");
    const r3 = (await pGood) as ManualRun;
    expect(r3.id).toBe(`${session.id}:run3`);
    r3.finish();
    await drain(r3);
    await session.close();
  });

  it("an aborted signal dequeues without spawning", async () => {
    const spawned: string[] = [];
    const session = new DefaultSession({
      runFactory: (id, prompt: PromptContent, _opts: SessionRunOptions) => {
        spawned.push(typeof prompt === "string" ? prompt : "?");
        return manualRun(id);
      },
    });
    const r1 = (await session.run("m1")) as ManualRun;
    const { signal, abort } = manualSignal();
    const p2 = session.run("m2", { queue: true, signal });
    abort();
    await expect(p2).rejects.toThrow(/aborted/);
    expect(spawned).toEqual(["m1"]);
    // Session stays usable after an abort.
    r1.finish();
    const r3 = (await session.run("m3")) as ManualRun;
    expect(spawned).toEqual(["m1", "m3"]);
    r3.finish();
    await session.close();
  });

  it("close() rejects everything still queued", async () => {
    const session = new DefaultSession({
      runFactory: (id) => manualRun(id),
    });
    await session.run("m1");
    const p2 = session.run("m2", { queue: true });
    const p3 = session.run("m3", { queue: true });
    await session.close();
    await expect(p2).rejects.toThrow(/closed/);
    await expect(p3).rejects.toThrow(/closed/);
  });

  it("cancel() stops the active turn but keeps the queue", async () => {
    const session = new DefaultSession({
      runFactory: (id) => manualRun(id),
    });
    const r1 = (await session.run("m1")) as ManualRun;
    const p2 = session.run("m2", { queue: true });
    await session.cancel();
    await drain(r1);
    const r2 = (await p2) as ManualRun;
    expect(r2.id).toBe(`${session.id}:run2`);
    r2.finish();
    await drain(r2);
    await session.close();
  });

  it("real stub runs dispatch through the drained tap path", async () => {
    // No factory: core stub processes. Draining exercises the events-tap
    // trigger (as opposed to the result() backup above).
    const session = new DefaultSession();
    const r1 = await session.run("a");
    const p2 = session.run("b", { queue: true });
    await drain(r1);
    const r2 = await p2;
    await drain(r2);
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
    await session.close();
  });
});
