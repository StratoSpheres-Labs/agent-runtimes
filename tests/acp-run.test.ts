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
