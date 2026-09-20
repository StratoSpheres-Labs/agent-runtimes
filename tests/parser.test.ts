import { describe, expect, it } from "vitest";
import { JsonlParser } from "../src/parser/jsonl.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("JsonlParser", () => {
  it("parses single text_delta", () => {
    const p = new JsonlParser();
    const evs = p.parse(enc('{"type":"text_delta","text":"hi"}\n'));
    expect(evs).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  it("handles partial chunk split across calls", () => {
    const p = new JsonlParser();
    const a = p.parse(enc('{"type":"text_delta","text":"Hel'));
    expect(a).toEqual([]); // buffered
    const b = p.parse(enc('lo"}\n'));
    expect(b).toEqual([{ type: "text_delta", text: "Hello" }]);
  });

  it("handles multiple events coalesced in one chunk", () => {
    const p = new JsonlParser();
    const chunk = [
      '{"type":"text_delta","text":"a"}\n',
      '{"type":"text_delta","text":"b"}\n',
      '{"type":"done"}\n',
    ].join("");
    const evs = p.parse(enc(chunk));
    expect(evs.map((e) => e.type)).toEqual(["text_delta", "text_delta", "done"]);
  });

  it("maps reasoning shapes to reasoning_delta; empty text drops silently", () => {
    const p = new JsonlParser();
    const evs = p.parse(
      enc('{"type":"reasoning_delta","text":"hmm"}\n{"type":"reasoning","text":"ah"}\n'),
    );
    expect(evs).toEqual([
      { type: "reasoning_delta", text: "hmm" },
      { type: "reasoning_delta", text: "ah" },
    ]);
    // Empty text is a valid envelope with nothing displayable — dropped,
    // and crucially NOT an INVALID_JSON error.
    const dropped = p.parse(enc('{"type":"reasoning","text":""}\n'));
    expect(dropped).toEqual([]);
  });

  it("emits error event for illegal JSON", () => {
    const p = new JsonlParser();
    const evs = p.parse(enc("not json\n"));
    expect(evs[0]?.type).toBe("error");
    expect((evs[0] as { error: { code: string } }).error.code).toBe("INVALID_JSON");
  });

  it("emits error for unknown event type", () => {
    const p = new JsonlParser();
    const evs = p.parse(enc('{"type":"weird_xyz"}\n'));
    expect(evs[0]?.type).toBe("error");
    expect((evs[0] as { error: { code: string } }).error.code).toBe("UNKNOWN_EVENT");
  });

  it("ignores empty lines", () => {
    const p = new JsonlParser();
    const evs = p.parse(enc('\n\n{"type":"done"}\n\n'));
    expect(evs.map((e) => e.type)).toEqual(["done"]);
  });

  it("flush handles trailing partial without newline", () => {
    const p = new JsonlParser();
    p.parse(enc('{"type":"done"}'));
    const flushed = p.flush();
    expect(flushed.map((e) => e.type)).toEqual(["done"]);
  });

  it("leaves runId unset — stamping is the Run's job (Rule 4)", () => {
    const p = new JsonlParser();
    const evs = p.parse(
      enc('{"type":"text_delta","text":"a"}\n{"type":"session_started","sessionId":"s"}\n'),
    );
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) expect(e.runId).toBeUndefined();
  });

  it("reset clears buffer", () => {
    const p = new JsonlParser();
    p.parse(enc('{"type":"text_delta","text":"x'));
    p.reset();
    const evs = p.parse(enc('{"type":"done"}\n'));
    expect(evs.map((e) => e.type)).toEqual(["done"]);
  });

  it("tool events round-trip", () => {
    const p = new JsonlParser();
    const a = p.parse(
      enc('{"type":"tool_started","id":"t1","name":"bash","input":{"cmd":"ls"}}\n'),
    );
    expect(a[0]).toMatchObject({ type: "tool_started", id: "t1", name: "bash" });
    const b = p.parse(enc('{"type":"tool_finished","id":"t1","output":{"ok":true}}\n'));
    expect(b[0]).toMatchObject({ type: "tool_finished", id: "t1" });
  });
});
