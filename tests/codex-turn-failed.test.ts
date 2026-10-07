import { describe, expect, it } from "vitest";
import { CodexParser } from "../runtimes/codex/parser.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";

/**
 * Captured VERIFIED LIVE from `codex exec --json` on 2026-10-06, on a box
 * where codex could not reach chatgpt.com. The shape is the point, not the
 * text: `turn.failed` carries the actionable reason, and the process exit
 * code (1) carries none.
 */
const LIVE_FAILED_TURN: string[] = [
  JSON.stringify({ type: "thread.started", thread_id: "01a110d7-6aab-77a3-8113-0b3f08b30311" }),
  JSON.stringify({ type: "turn.started" }),
  // Transient reconnect notices: progress noise, deliberately not surfaced as
  // `error` events — those would flip a recoverable turn to a failed one.
  JSON.stringify({
    type: "error",
    message: "Reconnecting... 2/5 (workspace routing discovery timed out)",
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "error",
      message: "Codex is ignoring 1 unrecognized configuration setting.",
    },
  }),
  JSON.stringify({
    type: "turn.failed",
    error: { message: "workspace routing discovery timed out" },
  }),
];

function parse(lines: readonly string[]): RuntimeEvent[] {
  const parser = new CodexParser();
  const encoder = new TextEncoder();
  const out: RuntimeEvent[] = [];
  for (const line of lines) {
    for (const event of parser.parse(encoder.encode(`${line}\n`))) out.push(event);
  }
  return out;
}

it("does not surface transient reconnect notices as errors", () => {
  // The specific bug: a *recovering* turn must not be marked failed on each
  // retry. Verified live — 5 notices, 5 spurious failures.
  const events = parse(LIVE_FAILED_TURN);
  expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("Reconnecting");
  expect(JSON.stringify(events)).not.toContain("UNKNOWN");
});

describe("codex parser — a failed turn keeps its reason", () => {
  it("surfaces turn.failed's message as the error, not a bare exit code", () => {
    const events = parse(LIVE_FAILED_TURN);
    const errors = events.filter((e) => e.type === "error");
    // The whole point: the caller learns WHY, not just "code 1".
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      error: { message: "workspace routing discovery timed out" },
    });
    expect((errors[0] as { error: { message: string } }).error.message).not.toContain(
      "Process exited",
    );
  });

  it("ends the turn with a terminal done", () => {
    const events = parse(LIVE_FAILED_TURN);
    // Required for the reason to survive: `Run` suppresses its own
    // NON_ZERO_EXIT once the parser has emitted a done.
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("still captures the session id before failing", () => {
    const events = parse(LIVE_FAILED_TURN);
    expect(events[0]).toEqual({
      type: "session_started",
      sessionId: "01a110d7-6aab-77a3-8113-0b3f08b30311",
    });
  });

  it("does not turn transient reconnect notices into errors", () => {
    const events = parse(LIVE_FAILED_TURN);
    // "Reconnecting... 2/5" is progress, not failure — surfacing it as an
    // `error` event would mark a still-recovering turn as failed.
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Reconnecting");
  });

  it("keeps dropping item.completed/error config warnings", () => {
    // Pre-existing, deliberate: a config typo must not false-alarm a turn.
    const events = parse(LIVE_FAILED_TURN);
    expect(JSON.stringify(events)).not.toContain("unrecognized configuration setting");
  });

  it("falls back to a stated failure when the reason is missing", () => {
    const events = parse([JSON.stringify({ type: "turn.failed" })]);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { error: { message: string } }).error.message).toContain(
      "no reason given",
    );
  });

  it("uses a reported error code when codex supplies one", () => {
    const events = parse([
      JSON.stringify({
        type: "turn.failed",
        error: { code: "rate_limited", message: "slow down" },
      }),
    ]);
    expect(events[0]).toMatchObject({ error: { code: "rate_limited", message: "slow down" } });
  });
});
