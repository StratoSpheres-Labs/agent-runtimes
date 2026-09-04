import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AcpParser } from "../src/parser/acp.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function line(obj: unknown): Uint8Array {
  return enc(`${JSON.stringify(obj)}\n`);
}

describe("AcpParser fixtures", () => {
  it("parses acp-turn.jsonl → RuntimeEvent", () => {
    const raw = readFileSync("runtimes/opencode-acp/fixtures/acp-turn.jsonl", "utf-8");
    const p = new AcpParser();
    // Feed in halves to prove chunk-split safety.
    const mid = Math.floor(raw.length / 2);
    const a = p.parse(enc(raw.slice(0, mid)));
    const b = p.parse(enc(raw.slice(mid)));
    const all = [...a, ...b, ...p.flush()];
    expect(all.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "tool_started",
      "tool_finished",
      "usage",
    ]);
    const texts = all
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["hello", " world"]);
    expect(all.some((e) => e.type === "error")).toBe(false);
    expect(all.some((e) => e.type === "done")).toBe(false);
  });
});

describe("AcpParser mapping", () => {
  it("ignores responses (driver consumes them via correlation)", () => {
    const p = new AcpParser();
    expect(p.parse(line({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }))).toEqual(
      [],
    );
    expect(
      p.parse(line({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } })),
    ).toEqual([]);
    expect(p.flush()).toEqual([]);
  });

  it("drops thought/unknown updates without error spam but emits usage", () => {
    const p = new AcpParser();
    const evs = p.parse(
      enc(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}\n` +
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"usage_update","used":1}}}\n` +
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"future_kind_xyz"}}}\n`,
      ),
    );
    const flushed = p.flush();
    const all = [...evs, ...flushed];
    expect(all.filter((e) => e.type === "usage").length).toBe(1);
    expect(all.filter((e) => e.type === "error").length).toBe(0);
    expect(all.filter((e) => e.type === "usage")[0]).toMatchObject({ type: "usage" });
  });

  it("maps in-progress tool updates to nothing and failed ones to errored finish", () => {
    const p = new AcpParser();
    const evs = p.parse(
      enc(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"c","status":"in_progress"}}}\n` +
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"c","status":"failed"}}}\n`,
      ),
    );
    expect([...evs, ...p.flush()]).toEqual([
      { type: "tool_finished", id: "c", output: undefined, error: true },
    ]);
  });

  it("flags garbage bytes without stalling", () => {
    const p = new AcpParser();
    const evs = p.parse(enc("not json{{{\n"));
    expect(evs[0]?.type).toBe("error");
    expect(p.flush()).toEqual([]);
  });
});
