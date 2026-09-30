import { describe, expect, it } from "vitest";
import { DefaultSession } from "../src/core/session.js";
import { EventStream } from "../src/events/event-stream.js";
import { shutdownAllSessions } from "../src/index.js";
import type { AgentRun } from "../src/core/run.js";
import type { ProcessExit } from "../src/core/lifecycle.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never-ending run double (finishes only when told). */
interface HangingRun extends AgentRun {
  finish(): void;
}

function hangingRun(id: string): HangingRun {
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
  return {
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
}

describe("session idle reaper", () => {
  it("closes an idle session after the timeout", async () => {
    const session = new DefaultSession({ idleTimeoutMs: 250 });
    await sleep(600);
    await expect(session.run("too late")).rejects.toThrow(/is closed/);
    await session.close();
  });

  it("run activity re-arms the timer", async () => {
    const session = new DefaultSession({ idleTimeoutMs: 300 });
    const run = await session.run("quick");
    for await (const e of run.events()) {
      if (e.type === "done") break;
    }
    // Turn just ended — still alive well before the timeout.
    await sleep(120);
    const run2 = await session.run("again");
    for await (const e of run2.events()) {
      if (e.type === "done") break;
    }
    // Then truly idle past the timeout — reaped.
    await sleep(800);
    await expect(session.run("too late")).rejects.toThrow(/is closed/);
    await session.close();
  });

  it("never reaps a session with a live turn (re-arms instead)", async () => {
    const holder: { current: HangingRun | null } = { current: null };
    const session = new DefaultSession({
      idleTimeoutMs: 250,
      runFactory: (id) => {
        const run = hangingRun(id);
        holder.current = run;
        return run;
      },
    });
    const r1 = await session.run("long");
    await sleep(600);
    // Still alive: the turn outlived the timeout twice over.
    expect(holder.current?.done).toBe(false);
    const queued = session.run("next", { queue: true });
    // Draining advances the tap, which dispatches the queue.
    holder.current?.finish();
    for await (const e of r1.events()) {
      if (e.type === "done") break;
    }
    const next = await queued;
    expect(next.done).toBe(false);
    await session.close();
  });

  it("reaps adapter sessions through their own close path", async () => {
    const { OpencodeSession } = await import("../runtimes/opencode/session.js");
    const sess = new OpencodeSession({
      id: "idle_acp",
      command: "agent-runtimes-missing-xyz",
      idleTimeoutMs: 250,
    });
    await sleep(600);
    await expect(sess.run("too late")).rejects.toThrow(/is closed/);
    await sess.close();
  });
});

describe("shutdownAllSessions", () => {
  it("closes every tracked session (runs cancelled, queued dropped)", async () => {
    const s1 = new DefaultSession();
    const s2 = new DefaultSession({
      runFactory: (id) => hangingRun(id),
    });
    const { OpencodeSession } = await import("../runtimes/opencode/session.js");
    const s3 = new OpencodeSession({ id: "idle_s3", command: "agent-runtimes-missing-xyz" });
    await s2.run("active");
    await shutdownAllSessions();
    await expect(s1.run("x")).rejects.toThrow(/is closed/);
    await expect(s2.run("x")).rejects.toThrow(/is closed/);
    await expect(s3.run("x")).rejects.toThrow(/is closed/);
  });
});
