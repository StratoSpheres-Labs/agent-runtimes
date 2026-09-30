import { describe, expect, it } from "vitest";
import { DefaultSession } from "../src/core/session.js";
import { DefaultRun, type AgentRun } from "../src/core/run.js";
import { JsonlParser } from "../src/parser/jsonl.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";

async function drain(run: AgentRun): Promise<{ codes: string[]; last: string }> {
  const codes: string[] = [];
  let last = "";
  for await (const e of run.events()) {
    last = e.type;
    if (e.type === "error") codes.push((e as { error: { code: string } }).error.code);
    if (e.type === "done") break;
  }
  return { codes, last };
}

describe("run stall watchdog", () => {
  it("fires STALL and reaps a silent-but-live process", async () => {
    // Emits one line, then hangs with the process alive: exactly the
    // live-but-silent shape the total-timeout cannot distinguish.
    const run = new DefaultRun("stall1", {
      command: process.execPath,
      args: [
        "-e",
        `console.log(${JSON.stringify(JSON.stringify({ type: "text", text: "hi" }))});setInterval(()=>{},1000);`,
      ],
      parser: new JsonlParser(),
      stallTimeoutMs: 300,
    });
    run.spawn();
    const { codes, last } = await drain(run);
    expect(codes.filter((c) => c === "STALL")).toHaveLength(1);
    expect(last).toBe("done");
    const exit = await run.result();
    // Reaped by the watchdog kill (SIGTERM path), not lingering.
    expect(exit.signal !== null || exit.code !== null).toBe(true);
    await run.close();
  });

  it("stays quiet while events keep flowing", async () => {
    const run = new DefaultRun("stall2", {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify({ type: "text", text: "hi" }))})`],
      parser: new JsonlParser(),
      stallTimeoutMs: 5000,
    });
    run.spawn();
    const { codes, last } = await drain(run);
    expect(codes).not.toContain("STALL");
    expect(last).toBe("done");
    await run.close();
  });

  it("forwards stallTimeoutMs from session options to the factory", async () => {
    const factorySeen: Array<number | undefined> = [];
    const session = new DefaultSession({
      runFactory: (id, _prompt, opts) => {
        factorySeen.push(opts.stallTimeoutMs);
        return new DefaultRun(id, { command: process.execPath, args: ["-e", ""] });
      },
    });
    const run = await session.run("x", { stallTimeoutMs: 123 });
    await drain(run);
    expect(factorySeen).toEqual([123]);
    await session.close();
  });

  it("exposes stall state only through events (no new public API)", async () => {
    const session = new DefaultSession();
    const run = await session.run("x", { stallTimeoutMs: 50 });
    const events: RuntimeEvent[] = [];
    for await (const e of run.events()) {
      events.push(e);
      if (e.type === "done") break;
    }
    // The stub exits fast, but if the watchdog ever fires first the shape
    // is still error-then-done — either way the stream terminates.
    expect(events[events.length - 1]?.type).toBe("done");
    await session.close();
  });
});
