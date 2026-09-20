import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import { decodeRuntimeEventLine, encodeRuntimeEvent, isRuntimeEvent } from "../src/wire.js";
import { RuntimeProtocolError } from "../src/core/errors.js";
import type { WireCreateSessionOptions } from "../src/wire.js";

const EVERY_VARIANT: RuntimeEvent[] = [
  { type: "session_started", sessionId: "ses_1" },
  { type: "text_delta", text: "hi" },
  { type: "reasoning_delta", text: "hmm" },
  {
    type: "tool_started",
    id: "t1",
    name: "bash",
    input: { command: "echo hi", deep: [1, "x", null] },
  },
  { type: "tool_finished", id: "t1", output: "hi\n", error: false },
  {
    type: "error",
    error: { code: "E1", message: "boom", cause: { nested: true } },
  },
  { type: "done", exitCode: 0, signal: null },
  { type: "usage", inputTokens: 1, outputTokens: 2, model: "m", raw: { a: [1] } },
  {
    type: "permission_request",
    id: "p1",
    toolName: "Bash",
    options: [{ optionId: "allow", kind: "allow_once", label: "Allow" }],
    raw: { extra: "data" },
  },
];

describe("wire round-trip", () => {
  it("encodes every event variant to one line and back losslessly", () => {
    for (const event of EVERY_VARIANT) {
      const line = encodeRuntimeEvent(event);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trim().includes("\n")).toBe(false);
      expect(decodeRuntimeEventLine(line)).toEqual(event);
    }
  });

  it("round-trips optional runId losslessly", () => {
    const stamped: RuntimeEvent[] = [
      { type: "text_delta", text: "hi", runId: "sess_a:run1" },
      { type: "session_started", sessionId: "native-1", runId: "sess_a:run1" },
      { type: "done", runId: "sess_a:run1" },
    ];
    for (const event of stamped) {
      expect(decodeRuntimeEventLine(encodeRuntimeEvent(event))).toEqual(event);
    }
    // Unstamped (parser-side) events still decode fine — runId is optional.
    expect(decodeRuntimeEventLine('{"type":"text_delta","text":"hi"}')).toEqual({
      type: "text_delta",
      text: "hi",
    });
  });

  it("coalesced lines split and decode independently", () => {
    const joined = EVERY_VARIANT.map((e) => encodeRuntimeEvent(e)).join("");
    const back = joined
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => decodeRuntimeEventLine(l));
    expect(back).toEqual(EVERY_VARIANT);
  });

  it("rejects malformed JSON and unknown discriminants", () => {
    expect(() => decodeRuntimeEventLine("not json{")).toThrow(RuntimeProtocolError);
    expect(() => decodeRuntimeEventLine('{"type":"teleport"}')).toThrow(RuntimeProtocolError);
    expect(() => decodeRuntimeEventLine("")).toThrow(RuntimeProtocolError);
  });

  it("isRuntimeEvent guards untrusted input", () => {
    for (const event of EVERY_VARIANT) {
      expect(isRuntimeEvent(JSON.parse(JSON.stringify(event)) as unknown)).toBe(true);
    }
    for (const junk of [null, 42, "x", [], {}, { type: "nope" }, { type: 7 }]) {
      expect(isRuntimeEvent(junk)).toBe(false);
    }
  });
});

describe("WireCreateSessionOptions", () => {
  it("carries the plain session options without the handler", () => {
    const opts: WireCreateSessionOptions = {
      cwd: "./proj",
      model: "sonnet",
      reasoning: { effort: "high" },
    };
    expect(opts.cwd).toBe("./proj");
    const withHandler: WireCreateSessionOptions = {
      // @ts-expect-error — functions never cross the wire
      onPermissionRequest: () => ({ optionId: "x" }),
    };
    expect(withHandler).toBeDefined();
  });
});
