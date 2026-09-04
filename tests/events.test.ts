import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import { DefaultSession } from "../src/core/session.js";

describe("RuntimeEvent", () => {
  it("type union is discriminable", () => {
    const ev: RuntimeEvent = { type: "text_delta", text: "hi" };
    expect(ev.type).toBe("text_delta");
    expect((ev as { text: string }).text).toBe("hi");
  });
});

describe("AgentRun.events()", () => {
  it("streams text_delta + done", async () => {
    const _session = new DefaultSession({
      runFactory: (_id) => {
        throw new Error("not used");
      },
    });
    const s2 = new DefaultSession();
    const run = await s2.run("hello events");
    const events: RuntimeEvent[] = [];
    for await (const ev of run.events()) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "done")).toBe(true);
    for (const e of events) {
      expect(typeof e.type).toBe("string");
      expect([
        "text_delta",
        "error",
        "done",
        "session_started",
        "tool_started",
        "tool_finished",
      ]).toContain(e.type);
    }
    await s2.close();
    // keep _session alive to avoid unused warning
    expect(_session.id).toBeDefined();
  });

  it("streams stdout as text_delta", async () => {
    const _s = new DefaultSession({
      runFactory: undefined,
    });
    const { DefaultRun } = await import("../src/core/run.js");
    const run = new DefaultRun("test:events2", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello'); process.stdout.write(' world')"],
    });
    run.spawn();
    const events: RuntimeEvent[] = [];
    for await (const ev of run.events()) {
      events.push(ev);
    }
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe("hello world");
    expect(events[events.length - 1]?.type).toBe("done");
    expect(_s.id).toBeDefined();
  });

  it("error + done on non-zero exit", async () => {
    const { DefaultRun } = await import("../src/core/run.js");
    const run = new DefaultRun("test:error", {
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    });
    run.spawn();
    const events: RuntimeEvent[] = [];
    for await (const ev of run.events()) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("done");
  });
});
