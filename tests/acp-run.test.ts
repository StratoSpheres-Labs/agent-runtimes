import { describe, expect, it } from "vitest";
import { AcpTransport } from "../src/transport/acp.js";
import { AcpRun } from "../src/core/acp-run.js";
import type { AgentRun } from "../src/core/run.js";

function mockTransport(mode: string): AcpTransport {
  return new AcpTransport({
    command: process.execPath,
    args: ["tests/fixtures/acp-mock-server.mjs", mode],
  });
}

async function collect(run: AgentRun): Promise<{ types: string[]; text: string }> {
  const types: string[] = [];
  let text = "";
  try {
    for await (const e of run.events()) {
      types.push(e.type);
      if (e.type === "text_delta") text += (e as { text: string }).text;
      if (e.type === "done") break;
    }
  } finally {
    await run.close();
  }
  return { types, text };
}

describe("AcpRun", () => {
  it("drives a full turn to text + done", async () => {
    const run = new AcpRun("test:turn", { transport: mockTransport("turn"), cwd: process.cwd() });
    await run.start("hi");
    const { types, text } = await collect(run);
    expect(text).toBe("hi there");
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_finished");
    expect(types).toContain("done");
    await expect(run.result()).resolves.toEqual({ code: 0, signal: null });
  }, 15000);

  it("answers agent permission requests without stalling", async () => {
    const run = new AcpRun("test:perm", {
      transport: mockTransport("permission"),
      cwd: process.cwd(),
    });
    await run.start("hi");
    const { types, text } = await collect(run);
    expect(text).toContain("-32601");
    expect(types).toContain("done");
  }, 15000);

  it("answers unknown fs methods with -32601", async () => {
    const run = new AcpRun("test:fs", { transport: mockTransport("fs"), cwd: process.cwd() });
    await run.start("hi");
    const { types, text } = await collect(run);
    expect(text).toContain("-32601");
    expect(types).toContain("done");
  }, 15000);

  it("cancel ends the stream with done (hang mode)", async () => {
    const run = new AcpRun("test:cancel", { transport: mockTransport("hang"), cwd: process.cwd() });
    await run.start("hi");
    await run.cancel();
    const types: string[] = [];
    for await (const e of run.events()) {
      types.push(e.type);
    }
    expect(types[0]).toBe("session_started");
    expect(types[types.length - 1]).toBe("done");
    expect(types.filter((t) => t === "done")).toHaveLength(1);
  }, 15000);

  it("marks done when the turn completes (session gate opens)", async () => {
    // AcpRun._done was never assigned: every second run on an ACP session
    // threw "already has an active run". Regression test.
    const run = new AcpRun("test:donegate", {
      transport: mockTransport("turn"),
      cwd: process.cwd(),
    });
    await run.start("hi");
    expect(run.done).toBe(false);
    for await (const e of run.events()) {
      if (e.type === "done") break;
    }
    expect(run.done).toBe(true);
    await run.close();
  }, 15000);

  it("a rejected start reaps the child (no zombie)", async () => {
    // Regression: the handshake failed AFTER spawn and nobody closed the
    // transport — the long-lived agent process survived as an orphan.
    // start() now closes before throwing.
    const transport = mockTransport("refuse-new");
    const run = new AcpRun("test:refuse", { transport, cwd: process.cwd() });
    await expect(run.start("hi")).rejects.toThrow();
    // start() closes before throwing: the child handle is reaped and the
    // transport reports stopped. Without the fix the mock (stdin open,
    // never exits by itself) stays alive with state "running" — a zombie.
    expect(transport.state).toBe("stopped");
    const pid = transport.pid;
    if (pid !== undefined) {
      // A still-tracked handle must already be dead, never alive.
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await run.close(); // idempotent after failed start
  }, 15000);

  it("falls back to set_config_option when set_model is missing (2.x live)", async () => {
    // The mock speaks the 2.x surface (no session/set_model): a run with
    // an explicit model must still start via session/set_config_option.
    const run = new AcpRun("test:model2x", {
      transport: mockTransport("turn"),
      cwd: process.cwd(),
      model: "opencode/mimo-v2.6-flash-free",
    });
    try {
      await run.start("hi");
      const { types, text } = await collect(run);
      expect(text).toBe("hi there");
      expect(types).toContain("done");
    } finally {
      await run.close();
    }
  }, 15000);

  it("failed turns resolve result() (never an unhandled rejection)", async () => {
    // Alignment with DefaultRun: the typed failure rides the stream as an
    // error event + done; result() resolves non-zero. A drain-only consumer
    // that never touches result() must not die.
    const run = new AcpRun("test:timeout-resolves", {
      transport: mockTransport("hang"),
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    await run.start("hi");
    const codes: string[] = [];
    const types: string[] = [];
    for await (const e of run.events()) {
      types.push(e.type);
      if (e.type === "error") codes.push(e.error.code);
      if (e.type === "done") break;
    }
    expect(codes).toContain("TIMEOUT");
    expect(types[types.length - 1]).toBe("done");
    await expect(run.result()).resolves.toEqual({ code: 1, signal: null });
    await run.close();
  }, 15000);

  it("fires STALL on a silent turn and still ends with done", async () => {
    // Hang mock never answers session/prompt; the watchdog (not the 120s
    // turn timeout) must end it: exactly one STALL, then done, and
    // result() resolves non-zero like any other turn failure.
    const run = new AcpRun("test:stall", {
      transport: mockTransport("hang"),
      cwd: process.cwd(),
      stallTimeoutMs: 300,
    });
    await run.start("hi");
    const codes: string[] = [];
    const types: string[] = [];
    for await (const e of run.events()) {
      types.push(e.type);
      if (e.type === "error") codes.push(e.error.code);
      if (e.type === "done") break;
    }
    expect(codes.filter((c) => c === "STALL")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("done");
    // Cancelled by the watchdog (not failed): null exit, reason in the event.
    await expect(run.result()).resolves.toEqual({ code: null, signal: null });
    await run.close();
  }, 15000);

  it("emits session_started with the native id", async () => {
    const run = new AcpRun("test:sid", { transport: mockTransport("turn"), cwd: process.cwd() });
    try {
      await run.start("hi");
      const ids: string[] = [];
      for await (const e of run.events()) {
        if (e.type === "session_started") ids.push((e as { sessionId: string }).sessionId);
        if (e.type === "done") break;
      }
      expect(ids).toEqual(["ses_mock"]);
    } finally {
      await run.close();
    }
  }, 15000);
});
