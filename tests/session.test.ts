import { describe, expect, it } from "vitest";
import { RuntimeSessionError } from "../src/core/errors.js";
import { DefaultSession } from "../src/core/session.js";
import { DefaultRun } from "../src/core/run.js";
import { JsonlParser } from "../src/parser/jsonl.js";
import { splitPromptContent } from "../src/definition/content.js";

describe("DefaultSession", () => {
  it("holds stable id across multiple runs (Session !== Process)", async () => {
    const session = new DefaultSession({ cwd: process.cwd() });
    const id = session.id;
    const run1 = await session.run("prompt 1");
    const pid1 = (run1 as unknown as { pid?: number }).pid;
    await run1.result();
    expect(run1.done).toBe(true);

    const run2 = await session.run("prompt 2");
    await run2.result();
    // Session id stable, runs have distinct ids/pids
    expect(session.id).toBe(id);
    expect(run1.id).not.toBe(run2.id);
    const pid2 = (run2 as unknown as { pid?: number }).pid;
    // Pids differ (two separate processes) — proves Session !== Process
    if (pid1 !== undefined && pid2 !== undefined) {
      expect(pid1).not.toBe(pid2);
    }
    await session.close();
  });

  it("cancel stops the active run", async () => {
    const session = new DefaultSession();
    const run = await session.run("long prompt");
    expect(run.done).toBe(false);
    await session.cancel();
    // After cancel the run should be done (killed)
    expect(run.done).toBe(true);
    await session.close();
  });

  it("close is idempotent and cleans all runs", async () => {
    const session = new DefaultSession();
    const ra = await session.run("a");
    await ra.result();
    const rb = await session.run("b");
    await rb.result();
    await session.close();
    await session.close(); // second close must not throw
    await expect(session.run("after close")).rejects.toThrow();
  });

  it("second run while active rejects instead of silently cancelling", async () => {
    const session = new DefaultSession();
    const first = await session.run("long prompt");
    expect(first.done).toBe(false);
    await expect(session.run("second prompt")).rejects.toThrow(RuntimeSessionError);
    // The first run is untouched — still active, still completable.
    expect(first.done).toBe(false);
    await session.cancel();
    expect(first.done).toBe(true);
    // Once the previous run settles, the session accepts new runs again.
    const next = await session.run("after settle");
    await next.result();
    expect(next.done).toBe(true);
    await session.close();
  });

  it("parser-level done releases the gate before process exit", async () => {
    // A slow-exiting child must not block back-to-back turns: the gate
    // opens on the turn's `done`, not on process reap. Regression test —
    // codex print mode lingers in teardown and spuriously rejected run 2.
    const session = new DefaultSession({
      runFactory: (id, prompt, opts) =>
        new DefaultRun(id, {
          command: process.execPath,
          args: ["-e", `console.log(JSON.stringify({type:"done"}));setTimeout(()=>{},8000);`],
          stdinData: splitPromptContent(prompt).text,
          parser: new JsonlParser(),
          timeout: opts.timeout,
        }),
    });
    const first = await session.run("one");
    for await (const e of first.events()) {
      if (e.type === "done") break;
    }
    expect(first.done).toBe(true);
    // Process still alive (8s sleep) — the second run must NOT reject.
    const second = await session.run("two");
    await session.cancel();
    await second.result().catch(() => {});
    expect(second.done).toBe(true);
    await session.close();
  });

  it("run timeout surfaces a TIMEOUT error event (not generic PROCESS_ERROR)", async () => {
    // Frontend code must tell "too slow" apart from "crashed" without
    // string-matching messages (ACP runs already emit TIMEOUT).
    const session = new DefaultSession({
      runFactory: (id, prompt, opts) =>
        new DefaultRun(id, {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          stdinData: splitPromptContent(prompt).text,
          timeout: opts.timeout ?? 200,
        }),
    });
    const run = await session.run("slow", { timeout: 200 });
    const codes: string[] = [];
    const types: string[] = [];
    for await (const e of run.events()) {
      types.push(e.type);
      if (e.type === "error") codes.push(e.error.code);
      if (e.type === "done") break;
    }
    expect(codes).toContain("TIMEOUT");
    expect(types[types.length - 1]).toBe("done");
    await session.close();
  });

  it("a throwing parser becomes a PARSER_ERROR event, never a host crash", async () => {
    // Before the guard, a parse() throw inside the stdout handler escaped
    // as uncaughtException and a flush() throw as unhandled rejection —
    // either kills the host process.
    const grenade = {
      parse(): never {
        throw new Error("grenade-parse");
      },
      flush(): never {
        throw new Error("grenade-flush");
      },
      reset(): void {},
    };
    const session = new DefaultSession({
      runFactory: (id, prompt) =>
        new DefaultRun(id, {
          command: process.execPath,
          args: ["-e", `console.log("hi")`],
          stdinData: splitPromptContent(prompt).text,
          parser: grenade,
        }),
    });
    const run = await session.run("x");
    const codes: string[] = [];
    const types: string[] = [];
    for await (const e of run.events()) {
      types.push(e.type);
      if (e.type === "error") codes.push(e.error.code);
      if (e.type === "done") break;
    }
    // One PARSER_ERROR from the data path, one from the flush path —
    // and the stream still terminates with done.
    expect(codes.filter((c) => c === "PARSER_ERROR").length).toBeGreaterThanOrEqual(2);
    expect(types[types.length - 1]).toBe("done");
    await session.close();
  });

  it("runFactory injection stays core-agnostic", async () => {
    let factoryCalls = 0;
    const session = new DefaultSession({
      runFactory: (id, prompt) => {
        factoryCalls++;
        let done = false;
        return {
          id,
          get done() {
            return done;
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async cancel() {
            done = true;
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async result() {
            // mark prompt as used without void operator
            if (prompt.length === -1) throw new Error("unreachable");
            done = true;
            return { code: 0, signal: null };
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async close() {
            done = true;
          },
        } as unknown as Awaited<ReturnType<DefaultSession["run"]>>;
      },
    });
    await session.run("via factory");
    expect(factoryCalls).toBe(1);
    await session.close();
  });
});
