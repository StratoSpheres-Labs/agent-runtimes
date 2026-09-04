import { describe, expect, it } from "vitest";
import { AcpParser } from "../src/parser/acp.js";
import { ClaudeParser } from "../runtimes/claude/parser.js";
import { CodexParser } from "../runtimes/codex/parser.js";
import { JsonlParser } from "../src/parser/jsonl.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("usage events", () => {
  it("AcpParser usage_update → usage", () => {
    const p = new AcpParser();
    const evs = p.parse(
      enc(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"usage_update","inputTokens":5,"outputTokens":10,"cost":0.01}}}\n`,
      ),
    );
    expect(evs[0]).toMatchObject({ type: "usage", inputTokens: 5, outputTokens: 10 });
    expect(evs[0]).toHaveProperty("raw");
  });

  it("Claude result → usage + done", () => {
    const p = new ClaudeParser();
    const line = `{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":20},"total_cost_usd":0.005}\n`;
    const evs = p.parse(enc(line));
    expect(evs.map((e) => e.type)).toEqual(["usage", "done"]);
    expect(evs[0]).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 20, costUsd: 0.005 });
  });

  it("Codex turn.completed with usage → usage + done", () => {
    const p = new CodexParser();
    const line = `{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":7}}\n`;
    const evs = p.parse(enc(line));
    expect(evs.map((e) => e.type)).toEqual(["usage", "done"]);
    expect(evs[0]).toMatchObject({ type: "usage" });
  });

  it("JsonlParser generic usage → usage", () => {
    const p = new JsonlParser();
    const evs = p.parse(enc(`{"type":"usage","inputTokens":1,"outputTokens":2}\n`));
    expect(evs[0]).toMatchObject({ type: "usage", inputTokens: 1, outputTokens: 2 });
  });

  it("codex turn.completed without usage → done only", () => {
    const p = new CodexParser();
    expect(p.parse(enc(`{"type":"turn.completed"}\n`))[0]?.type).toBe("done");
  });
});
