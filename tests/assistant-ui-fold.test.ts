import { describe, expect, it } from "vitest";
import { createAssistantTurn, MAX_TURN_PARTS } from "../src/frontend/assistant-ui/fold.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import type {
  AuiReasoningPart,
  AuiTextPart,
  AuiToolCallPart,
} from "../src/frontend/assistant-ui/types.js";

/** Feed a list of events through one turn and return the final snapshot. */
function fold(events: readonly RuntimeEvent[]) {
  const turn = createAssistantTurn();
  for (const event of events) turn.apply(event);
  return turn.snapshot();
}

function textOf(parts: readonly unknown[]): string {
  return parts
    .filter((p): p is AuiTextPart => (p as { type?: unknown }).type === "text")
    .map((p) => p.text)
    .join("");
}

function toolParts(parts: readonly unknown[]): AuiToolCallPart[] {
  return parts.filter((p): p is AuiToolCallPart => (p as { type?: unknown }).type === "tool-call");
}

/** One of every known discriminant — used to prove a clean fold stays clean. */
const EVERY_EVENT: RuntimeEvent[] = [
  { type: "session_started", sessionId: "s" },
  { type: "text_delta", text: "t" },
  { type: "reasoning_delta", text: "r" },
  { type: "tool_started", id: "t1", name: "bash" },
  { type: "tool_finished", id: "t1", output: "ok" },
  { type: "permission_request", id: "p1", options: [{ optionId: "a", kind: "allow_once" }] },
  { type: "permission_denied", id: "p2" },
  { type: "usage", inputTokens: 1, outputTokens: 2 },
  { type: "error", error: { code: "X", message: "y" } },
  { type: "done" },
];

describe("fold — text and reasoning", () => {
  it("accumulates text deltas into ONE trailing text part (cumulative, not delta)", () => {
    const s = fold([
      { type: "text_delta", text: "He" },
      { type: "text_delta", text: "llo" },
      { type: "text_delta", text: "!" },
    ]);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toEqual({ type: "text", text: "Hello!" });
    expect(s.textChars).toBe(6);
  });

  it("never emits an empty text or reasoning part (only the last part may run)", () => {
    const s = fold([
      { type: "text_delta", text: "" },
      { type: "reasoning_delta", text: "" },
      { type: "text_delta", text: "x" },
      { type: "text_delta", text: "" },
    ]);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toEqual({ type: "text", text: "x" });
  });

  it("keeps reasoning and text as separate parts and never mixes them", () => {
    const s = fold([
      { type: "reasoning_delta", text: "thinking" },
      { type: "text_delta", text: "answer" },
    ]);
    expect(s.parts).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
    ]);
  });

  it("preserves interleaving order: reasoning → tool → text", () => {
    const s = fold([
      { type: "reasoning_delta", text: "plan" },
      { type: "tool_started", id: "t1", name: "read" },
      { type: "tool_finished", id: "t1", output: "ok" },
      { type: "text_delta", text: "done" },
    ]);
    expect(s.parts.map((p) => p.type)).toEqual(["reasoning", "tool-call", "text"]);
  });

  it("starts a new text part when a tool call splits the text stream", () => {
    const s = fold([
      { type: "text_delta", text: "before " },
      { type: "tool_started", id: "t1", name: "bash" },
      { type: "text_delta", text: "after" },
    ]);
    // Two text parts, in order — this is what keeps interleaving visible.
    expect(textOf(s.parts)).toBe("before after");
    expect(s.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
  });

  it("merges consecutive reasoning deltas into one reasoning part", () => {
    const s = fold([
      { type: "reasoning_delta", text: "a" },
      { type: "reasoning_delta", text: "b" },
    ]);
    const reasoning = s.parts.filter((p): p is AuiReasoningPart => p.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("ab");
  });
});

describe("fold — tool calls", () => {
  it("maps tool_started input to args + argsText", () => {
    const s = fold([{ type: "tool_started", id: "t1", name: "bash", input: { command: "ls" } }]);
    expect(toolParts(s.parts)[0]).toEqual({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
      argsText: '{"command":"ls"}',
    });
  });

  it("wraps non-object input under `value` and keeps the raw JSON in argsText", () => {
    const [plain, array] = [
      toolParts(fold([{ type: "tool_started", id: "a", name: "n", input: "raw string" }]).parts)[0],
      toolParts(fold([{ type: "tool_started", id: "b", name: "n", input: [1, 2] }]).parts)[0],
    ];
    // assistant-ui types `args` as an object; non-objects get a stable key so
    // nothing is lost, and argsText always carries the original JSON.
    expect(plain?.args).toEqual({ value: "raw string" });
    expect(plain?.argsText).toBe('"raw string"');
    expect(array?.args).toEqual({ value: [1, 2] });
    expect(array?.argsText).toBe("[1,2]");
  });

  it("defaults args/argsText when the event carries no input", () => {
    const call = toolParts(fold([{ type: "tool_started", id: "t1", name: "n" }]).parts)[0];
    expect(call?.args).toEqual({});
    expect(call?.argsText).toBe("{}");
  });

  it("fills result and isError on tool_finished", () => {
    const s = fold([
      { type: "tool_started", id: "t1", name: "bash" },
      { type: "tool_finished", id: "t1", output: "done", error: false },
    ]);
    const call = toolParts(s.parts)[0];
    expect(call?.result).toBe("done");
    expect(call?.isError).toBe(false);
  });

  it("surfaces a tool error as isError without an approval gate", () => {
    const s = fold([
      { type: "tool_started", id: "t1", name: "bash" },
      { type: "tool_finished", id: "t1", error: true },
      { type: "done", exitCode: 1 },
    ]);
    const call = toolParts(s.parts)[0];
    expect(call?.isError).toBe(true);
    expect(call?.approval).toBeUndefined();
    // A failed tool is NOT blocked — an ordinary failure has no gate, so the
    // turn settles complete rather than waiting on the user.
    expect(s.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("creates a synthetic call when tool_finished arrives without tool_started", () => {
    const s = fold([{ type: "tool_finished", id: "orphan", output: "x" }]);
    const call = toolParts(s.parts)[0];
    expect(call?.toolCallId).toBe("orphan");
    expect(call?.toolName).toBe("unknown");
    expect(call?.result).toBe("x");
  });
});

describe("fold — permissions", () => {
  it("stamps a pending approval and requires-action on the tool call", () => {
    const s = fold([
      { type: "tool_started", id: "p1", name: "Bash" },
      {
        type: "permission_request",
        id: "p1",
        toolName: "Bash",
        prompt: "Run rm?",
        options: [{ optionId: "allow", kind: "allow_once", label: "Allow" }],
      },
    ]);
    expect(toolParts(s.parts)[0]?.approval).toEqual({
      id: "p1",
      prompt: "Run rm?",
      options: [{ id: "allow", kind: "allow-once", label: "Allow" }],
    });
    expect(s.status).toEqual({ type: "requires-action", reason: "tool-calls" });
  });

  it("normalizes underscore approval kinds to assistant-ui's hyphenated set", () => {
    const s = fold([
      {
        type: "permission_request",
        id: "p1",
        options: [
          { optionId: "a", kind: "allow_always" },
          { optionId: "b", kind: "reject_forever" },
        ],
      },
    ]);
    // Unknown kinds pass through (normalized) — assistant-ui's kind union is open.
    expect(toolParts(s.parts)[0]?.approval?.options).toEqual([
      { id: "a", kind: "allow-always" },
      { id: "b", kind: "reject-forever" },
    ]);
  });

  it("omits options entirely when the event offers none (plain Allow/Deny pair)", () => {
    const s = fold([{ type: "permission_request", id: "p1", options: [] }]);
    // An empty options array would render nothing clickable.
    expect(toolParts(s.parts)[0]?.approval).toEqual({ id: "p1" });
  });

  it("settles an approval via resolveApproval and leaves the gate", () => {
    const turn = createAssistantTurn();
    turn.apply({
      type: "permission_request",
      id: "p1",
      options: [{ optionId: "yes", kind: "allow_once" }],
    });
    expect(turn.snapshot().status).toEqual({ type: "requires-action", reason: "tool-calls" });

    expect(turn.resolveApproval("p1", { approved: true, optionId: "yes" })).toBe(true);
    const s = turn.snapshot();
    expect(toolParts(s.parts)[0]?.approval?.approved).toBe(true);
    expect(s.status).toEqual({ type: "running" });
  });

  it("synthesizes an error result on a denial so the card reads 'blocked'", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "permission_request", id: "p1", options: [] });
    turn.resolveApproval("p1", { approved: false, reason: "not on this box" });
    const call = toolParts(turn.snapshot().parts)[0];
    expect(call?.approval?.approved).toBe(false);
    expect(call?.isError).toBe(true);
    expect(call?.result).toEqual({ error: "not on this box" });
  });

  it("returns false when resolving an unknown approval", () => {
    const turn = createAssistantTurn();
    expect(turn.resolveApproval("nope", { approved: true })).toBe(false);
  });

  it("maps permission_denied to a settled denial WITHOUT requiring action", () => {
    const s = fold([
      { type: "tool_started", id: "p1", name: "Write" },
      { type: "permission_denied", id: "p1", reason: "needs manual approval", kind: "safetyCheck" },
    ]);
    const call = toolParts(s.parts)[0];
    expect(call?.approval).toEqual({
      id: "p1",
      approved: false,
      reason: "needs manual approval",
    });
    expect(call?.isError).toBe(true);
    expect(call?.result).toEqual({ error: "needs manual approval", kind: "safetyCheck" });
    // Observe-only: the decision was already made, so nothing waits.
    expect(s.status).toEqual({ type: "running" });
  });

  it("defaults a denial reason when the event carries none", () => {
    const s = fold([{ type: "permission_denied", id: "p1" }]);
    expect(toolParts(s.parts)[0]?.result).toEqual({ error: "permission denied" });
  });

  it("treats a completed tool call as settling a pending gate", () => {
    const s = fold([
      { type: "permission_request", id: "p1", toolName: "Bash", options: [] },
      { type: "tool_finished", id: "p1", output: "ok" },
      { type: "done" },
    ]);
    expect(toolParts(s.parts)[0]?.approval?.approved).toBe(true);
    expect(s.status).toEqual({ type: "complete", reason: "stop" });
  });
});

describe("fold — status derivation", () => {
  it("is running until done", () => {
    expect(fold([{ type: "text_delta", text: "a" }]).status).toEqual({ type: "running" });
  });

  it("completes on done", () => {
    expect(
      fold([
        { type: "text_delta", text: "a" },
        { type: "done", exitCode: 0 },
      ]).status,
    ).toEqual({
      type: "complete",
      reason: "stop",
    });
  });

  it("settles a cancelled turn as incomplete/cancelled", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "text_delta", text: "partial" });
    turn.markCancelled();
    turn.apply({ type: "done", signal: "SIGTERM" });
    expect(turn.snapshot().status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("keeps the error over the cancel (most specific wins)", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "error", error: { code: "STALL", message: "no event" } });
    turn.markCancelled();
    turn.apply({ type: "done" });
    const s = turn.snapshot();
    expect(s.status.type).toBe("incomplete");
    expect(s.status).toMatchObject({ reason: "error" });
    expect(s.error).toEqual({ code: "STALL", message: "no event" });
  });

  it("exposes the error code on an incomplete status", () => {
    const s = fold([
      { type: "error", error: { code: "NON_ZERO_EXIT", message: "died" } },
      { type: "done", exitCode: 1 },
    ]);
    expect(s.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: { code: "NON_ZERO_EXIT", message: "died" },
    });
  });

  it("an error mid-stream does not discard the parts already folded", () => {
    const s = fold([
      { type: "text_delta", text: "partial answer" },
      { type: "error", error: { code: "TIMEOUT", message: "too slow" } },
    ]);
    expect(textOf(s.parts)).toBe("partial answer");
  });
});

describe("fold — metadata and robustness", () => {
  it("captures the native session id and the last usage", () => {
    const s = fold([
      { type: "session_started", sessionId: "ses_native" },
      { type: "usage", inputTokens: 10, outputTokens: 20, costUsd: 0.5, model: "sonnet" },
    ]);
    expect(s.nativeSessionId).toBe("ses_native");
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 0.5, model: "sonnet" });
  });

  it("last-wins on usage fields", () => {
    const s = fold([
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "usage", inputTokens: 5, outputTokens: 6 },
    ]);
    expect(s.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("fails open on an unknown event discriminant", () => {
    // The event set only grows; consumers must not throw on what they don't know.
    const alien = { type: "quantum_tunnel", payload: 1 } as unknown as RuntimeEvent;
    const s = fold([{ type: "text_delta", text: "kept" }, alien]);
    expect(textOf(s.parts)).toBe("kept");
    expect(s.status).toEqual({ type: "running" });
  });

  it("filters by runId but still accepts unstamped events", () => {
    const turn = createAssistantTurn({ runId: "sess_a:run1" });
    turn.apply({ type: "text_delta", text: "mine", runId: "sess_a:run1" });
    turn.apply({ type: "text_delta", text: "theirs", runId: "sess_b:run1" });
    turn.apply({ type: "text_delta", text: "unstamped" });
    expect(textOf(turn.snapshot().parts)).toBe("mineunstamped");
  });

  it("counts chunks for MessageTiming", () => {
    expect(
      fold([
        { type: "text_delta", text: "a" },
        { type: "text_delta", text: "b" },
      ]).chunks,
    ).toBe(2);
  });

  it("snapshots are independent copies (mutating one must not affect the next)", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "tool_started", id: "t1", name: "n" });
    const first = turn.snapshot();
    turn.apply({ type: "tool_finished", id: "t1", output: "later" });
    expect(toolParts(first.parts)[0]?.result).toBeUndefined();
    expect(toolParts(turn.snapshot().parts)[0]?.result).toBe("later");
  });
});

describe("fold — the data-* extension channel", () => {
  it("appends a structured data part after the text already streamed", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "text_delta", text: "Here you go:" });
    turn.emit({ type: "data-spec-sheet", data: { title: "Report", rows: 3 } });
    const s = turn.snapshot();
    expect(s.parts.map((p) => p.type)).toEqual(["text", "data-spec-sheet"]);
    expect(s.parts[1]).toEqual({ type: "data-spec-sheet", data: { title: "Report", rows: 3 } });
  });

  it("upserts an emitted tool call by toolCallId rather than duplicating it", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "tool_started", id: "t1", name: "bash", input: { cmd: "ls" } });
    turn.emit({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      args: { cmd: "ls -la" },
      argsText: '{"cmd":"ls -la"}',
      result: "patched",
    });
    const calls = toolParts(turn.snapshot().parts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ cmd: "ls -la" });
    expect(calls[0]?.result).toBe("patched");
  });

  it("throws on an empty text or reasoning part rather than corrupting the stream", () => {
    const turn = createAssistantTurn();
    // An empty trailing part marks the PREVIOUS part complete — silently
    // accepting it would truncate a streamed answer, so this is loud.
    expect(() => {
      turn.emit({ type: "text", text: "" });
    }).toThrow(TypeError);
    expect(() => {
      turn.emit({ type: "reasoning", text: "" });
    }).toThrow(TypeError);
  });
});

describe("fold — unknown events are recorded, not silently dropped", () => {
  it("records the type name and counts repeats", () => {
    // The event set only grows, so an unknown discriminant must never throw —
    // but dropping it SILENTLY means a CLI upgrade quietly loses content with
    // no way to notice. That is the same class of bug as a timeout being
    // treated as proof of a broken shim.
    const turn = createAssistantTurn();
    turn.apply({ type: "text_delta", text: "kept" });
    turn.apply({ type: "quantum_flux", payload: 1 } as unknown as RuntimeEvent);
    turn.apply({ type: "quantum_flux", payload: 2 } as unknown as RuntimeEvent);
    turn.apply({ type: "warp_drive" } as unknown as RuntimeEvent);

    const s = turn.snapshot();
    // Fail-open preserved: the known event still folded.
    expect(s.parts).toHaveLength(1);
    expect(s.unhandledEvents).toHaveLength(2);
    expect(s.unhandledEvents[0]).toMatchObject({ type: "quantum_flux", count: 2 });
    expect(s.unhandledEvents[1]).toMatchObject({ type: "warp_drive", count: 1 });
  });

  it("never retains the payload (untrusted wire data could echo a prompt)", () => {
    const turn = createAssistantTurn();
    turn.apply({
      type: "leaky",
      secret: "sk-should-never-be-retained",
    } as unknown as RuntimeEvent);
    const serialized = JSON.stringify(turn.snapshot().unhandledEvents);
    expect(serialized).not.toContain("sk-should-never-be-retained");
    expect(serialized).toContain("leaky");
  });

  it("stays empty when every event was understood", () => {
    const turn = createAssistantTurn();
    for (const event of EVERY_EVENT) turn.apply(event);
    expect(turn.snapshot().unhandledEvents).toEqual([]);
  });

  it("caps distinct types instead of growing without bound", () => {
    const turn = createAssistantTurn();
    for (let i = 0; i < 40; i += 1) {
      turn.apply({ type: `alien_${String(i)}` } as unknown as RuntimeEvent);
    }
    const unhandled = turn.snapshot().unhandledEvents;
    // 8 slots + one overflow bucket, however many arrive.
    expect(unhandled.length).toBeLessThanOrEqual(9);
    expect(unhandled.some((e) => e.type === "…")).toBe(true);
  });

  it("handles an event whose type is not even a string", () => {
    const turn = createAssistantTurn();
    turn.apply({ nope: true } as unknown as RuntimeEvent);
    expect(turn.snapshot().unhandledEvents[0]).toMatchObject({ type: "unknown" });
  });
});

describe("fold — streaming timing", () => {
  /** Deterministic clock: each call advances by `step` ms. */
  function clock(start = 1_000, step = 100): () => number {
    let t = start - step;
    return () => {
      t += step;
      return t;
    };
  }

  it("reports time-to-first-token, totals and chunk/tool counts once settled", () => {
    const turn = createAssistantTurn({ now: clock() });
    turn.apply({ type: "text_delta", text: "a" }); // start + first token
    turn.apply({ type: "text_delta", text: "b" });
    turn.apply({ type: "tool_started", id: "t1", name: "bash" });
    turn.apply({ type: "usage", outputTokens: 20 });
    turn.apply({ type: "done" });

    const t = turn.snapshot().timing;
    expect(t.streamStartTime).toBe(1_000);
    // Durations, not epochs: 100ms between the first event and the first delta.
    expect(t.firstTokenTime).toBe(100);
    expect(t.totalStreamTime).toBeGreaterThan(0);
    expect(t.tokenCount).toBe(20);
    expect(t.tokensPerSecond).toBeGreaterThan(0);
    expect(t.totalChunks).toBe(5);
    expect(t.toolCallCount).toBe(1);
  });

  it("omits totalStreamTime while the turn is still streaming", () => {
    const turn = createAssistantTurn({ now: clock() });
    turn.apply({ type: "text_delta", text: "a" });
    // Not settled — a moving total would make every consumer disagree.
    expect(turn.snapshot().timing.totalStreamTime).toBeUndefined();
    turn.apply({ type: "done" });
    expect(turn.snapshot().timing.totalStreamTime).toBeDefined();
  });

  it("freezes the total once settled (later snapshots do not drift)", () => {
    const now = clock();
    const turn = createAssistantTurn({ now });
    turn.apply({ type: "text_delta", text: "a" });
    turn.apply({ type: "done" });
    const first = turn.snapshot().timing.totalStreamTime;
    now(); // time passes…
    now();
    expect(turn.snapshot().timing.totalStreamTime).toBe(first);
  });

  it("omits firstTokenTime for a turn that only ran tools", () => {
    const turn = createAssistantTurn({ now: clock() });
    turn.apply({ type: "tool_started", id: "t1", name: "bash" });
    turn.apply({ type: "done" });
    expect(turn.snapshot().timing.firstTokenTime).toBeUndefined();
    expect(turn.snapshot().timing.toolCallCount).toBe(1);
  });

  it("omits tokenCount/tokensPerSecond without a usage event", () => {
    const turn = createAssistantTurn({ now: clock() });
    turn.apply({ type: "text_delta", text: "a" });
    turn.apply({ type: "done" });
    const t = turn.snapshot().timing;
    expect(t.tokenCount).toBeUndefined();
    expect(t.tokensPerSecond).toBeUndefined();
  });
});

describe("fold — bounded memory", () => {
  it("caps retained parts and reports how many were dropped", () => {
    const turn = createAssistantTurn();
    // Interleave tool calls so every text delta opens a NEW part instead of
    // merging into the trailing one.
    for (let i = 0; i < MAX_TURN_PARTS + 50; i += 1) {
      turn.apply({ type: "tool_started", id: `t${String(i)}`, name: "bash" });
      turn.apply({ type: "tool_finished", id: `t${String(i)}`, output: "x" });
      turn.apply({ type: "text_delta", text: `chunk ${String(i)} ` });
    }
    const snapshot = turn.snapshot();
    expect(snapshot.parts.length).toBeLessThanOrEqual(MAX_TURN_PARTS);
    expect(snapshot.droppedParts).toBeGreaterThan(0);
    // Oldest-first eviction: the newest chunk is still there.
    expect(textOf(snapshot.parts)).toContain(`chunk ${String(MAX_TURN_PARTS + 49)}`);
  });

  it("never evicts a tool call whose approval gate is still open", () => {
    const turn = createAssistantTurn();
    turn.apply({ type: "permission_request", id: "gated", toolName: "Bash", options: [] });
    for (let i = 0; i < MAX_TURN_PARTS + 20; i += 1) {
      turn.apply({ type: "tool_started", id: `t${String(i)}`, name: "bash" });
      turn.apply({ type: "tool_finished", id: `t${String(i)}`, output: "x" });
      turn.apply({ type: "text_delta", text: "noise " });
    }
    // Dropping the gate would silently discard a decision the user is looking
    // at, so it survives even though everything around it was evicted.
    expect(toolParts(turn.snapshot().parts).some((p) => p.toolCallId === "gated")).toBe(true);
  });

  it("does not count parts it never had to drop", () => {
    const turn = createAssistantTurn();
    for (let i = 0; i < 10; i += 1) turn.apply({ type: "text_delta", text: "a" });
    expect(turn.snapshot().droppedParts).toBe(0);
  });
});
