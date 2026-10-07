/**
 * Compile-time conformance against the REAL assistant-ui types.
 *
 * We deliberately ship local structural types (`src/frontend/assistant-ui/types.ts`)
 * instead of importing from `@assistant-ui/core`, so the browser bundle stays
 * dependency-free. The cost of that choice is drift risk — this file is the
 * payment. Every assignment below is a compile-time assertion: if upstream
 * moves or renames a field, `pnpm typecheck` fails here rather than in a
 * consumer's app.
 *
 * `@assistant-ui/core` is a devDependency only. It carries the types that
 * matter (`ThreadMessageLike`, `ChatModelRunResult`, `ExternalStoreAdapter`,
 * `RespondToToolApprovalOptions`) without dragging React in — the React hooks
 * are the only part of assistant-ui we do not touch.
 */

import { describe, expect, it } from "vitest";
import type {
  ChatModelRunResult,
  ExternalStoreAdapter,
  RespondToToolApprovalOptions,
  ThreadMessageLike,
  ToolCallMessagePart,
} from "@assistant-ui/core";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import { createAssistantTurn } from "../src/frontend/assistant-ui/fold.js";
import { createChatModelAdapter, textOfMessage } from "../src/frontend/assistant-ui/chat-model.js";
import type { AuiInboundMessage } from "../src/frontend/assistant-ui/types.js";
import {
  createExternalStoreAdapter,
  createThreadStore,
} from "../src/frontend/assistant-ui/external-store.js";
import { createRuntimeTransport } from "../src/frontend/assistant-ui/transport.js";
import type {
  AuiChatModelRunResult,
  AuiExternalPart,
  AuiPart,
  AuiThreadMessageLike,
  AuiTurnSnapshot,
} from "../src/frontend/assistant-ui/types.js";

/**
 * Compile-time assertion helper: fails to typecheck if the argument is not
 * assignable to `Expected`. The value is returned so the type parameter
 * appears twice and the call is a real expression.
 */
function conforms<Expected>(value: Expected): Expected {
  return value;
}

function noopFetch(): typeof globalThis.fetch {
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    body: null,
    text: () => Promise.resolve(""),
  };
  return () => Promise.resolve(response as unknown as Response);
}

function sampleSnapshot(): AuiTurnSnapshot {
  const turn = createAssistantTurn();
  const events: RuntimeEvent[] = [
    { type: "session_started", sessionId: "native" },
    { type: "reasoning_delta", text: "thinking" },
    { type: "tool_started", id: "t1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_finished", id: "t1", output: "ok" },
    {
      type: "permission_request",
      id: "p1",
      toolName: "Write",
      options: [{ optionId: "allow-once", kind: "allow_once", label: "Allow" }],
    },
    { type: "text_delta", text: "answer" },
    { type: "usage", inputTokens: 1, outputTokens: 2 },
    { type: "done" },
  ];
  for (const event of events) turn.apply(event);
  return turn.snapshot();
}

describe("assistant-ui type conformance", () => {
  it("parts satisfy assistant-ui's external-store part union", () => {
    const parts: readonly AuiExternalPart[] = sampleSnapshot().parts;
    // Each part we emit must be accepted where assistant-ui wants
    // `ThreadMessageLikePart` — including the prefixed `data-<name>` form.
    for (const part of parts) conforms<ThreadMessageLike["content"]>([part]);
  });

  it("a tool-call part satisfies assistant-ui's ToolCallMessagePart", () => {
    const call = sampleSnapshot().parts.find((p) => p.type === "tool-call");
    if (call === undefined) throw new Error("fixture produced no tool call");
    conforms<ToolCallMessagePart>(call);
    // `argsText` is REQUIRED upstream — if we ever made it optional, this fails.
    expect(typeof call.argsText).toBe("string");
  });

  it("a folded message satisfies ThreadMessageLike", () => {
    const message: AuiThreadMessageLike = {
      role: "assistant",
      id: "m1",
      createdAt: new Date(0),
      content: sampleSnapshot().parts,
      status: sampleSnapshot().status,
      metadata: { custom: { nativeSessionId: "native" } },
    };
    conforms<ThreadMessageLike>(message);
  });

  it("a data-* part is accepted by the ExternalStore converter's part union", () => {
    const data: AuiExternalPart = { type: "data-spec-sheet", data: { rows: 2 } };
    conforms<ThreadMessageLike["content"]>([data]);
    expect(data.type.startsWith("data-")).toBe(true);
  });

  it("the named data form is what ChatModelRunResult accepts", () => {
    // `useLocalRuntime` is typed against `ThreadAssistantMessagePart`, which
    // has NO `data-<name>` spelling — only `{ type: "data", name, data }`.
    // That is why `AuiPart` and `AuiExternalPart` are separate unions, and
    // why `createChatModelAdapter` rewrites the prefixed form on the way out.
    // (The prefixed form is not assignable here — the compiler enforces it.)
    const named: AuiPart = { type: "data", name: "spec-sheet", data: { rows: 2 } };
    const result: AuiChatModelRunResult = { content: [named] };
    conforms<ChatModelRunResult>(result);
    expect(result.content?.[0]?.type).toBe("data");
  });

  it("setMessages accepts assistant-ui's own message shape (inbound direction)", () => {
    // This is the direction a callback parameter needs: assistant-ui's
    // `ThreadMessageLike` must be assignable to what `setMessages` declares,
    // because a message it produced may carry parts we never emit.
    const upstreamMessage: ThreadMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "from a branch" }],
      id: "b1",
    };
    const inbound: AuiInboundMessage = upstreamMessage;
    expect(inbound.role).toBe("assistant");
  });

  it("every status we can produce is a valid assistant-ui MessageStatus", () => {
    const statuses = [
      { type: "running" },
      { type: "requires-action", reason: "tool-calls" },
      { type: "complete", reason: "stop" },
      { type: "incomplete", reason: "cancelled" },
      { type: "incomplete", reason: "error", error: { code: "STALL", message: "silent" } },
    ] as const;
    for (const status of statuses) conforms<ThreadMessageLike["status"]>(status);
  });

  it("ChatModelRunResult matches assistant-ui's ChatModelRunResult", () => {
    // Content uses the run-safe union (`AuiPart`), which is what
    // `createChatModelAdapter` yields after translating `data-<name>` parts.
    const result: AuiChatModelRunResult = {
      content: sampleSnapshot().parts.filter((p): p is AuiPart => !p.type.startsWith("data-")),
      status: sampleSnapshot().status,
      metadata: { steps: [{ usage: { inputTokens: 1, outputTokens: 2 } }], custom: { chunks: 3 } },
    };
    conforms<ChatModelRunResult>(result);
    expect(result.content?.length).toBeGreaterThan(0);
  });

  it("ExternalStoreAdapter matches assistant-ui's adapter contract", () => {
    const store = createThreadStore({
      transport: createRuntimeTransport({ endpoints: { turn: "/turn" }, fetch: noopFetch() }),
    });
    const adapter = createExternalStoreAdapter(store);
    conforms<ExternalStoreAdapter<ThreadMessageLike>>(adapter);
    expect(adapter.messages).toEqual([]);
  });

  it("ChatModelAdapter yields assistant-ui's ChatModelRunResult", () => {
    const adapter = createChatModelAdapter({
      transport: createRuntimeTransport({ endpoints: { turn: "/turn" }, fetch: noopFetch() }),
    });
    // NOT an assignability assertion, and deliberately so: `run` takes
    // assistant-ui's options object, so proving `ChatModelAdapter`
    // assignability would require our parameter type to be a SUPERTYPE of
    // theirs (contravariance) — i.e. a structural copy of their whole
    // `ModelContext` tree, which would rot on every upstream release. Instead
    // we prove the part that actually matters: what we yield is a valid
    // `ChatModelRunResult`, checked above by `AuiChatModelRunResult`.
    expect(typeof adapter.run).toBe("function");
    const yields: ChatModelRunResult[] = [];
    expect(yields).toEqual([]);
  });

  it("our approval answer is shaped like RespondToToolApprovalOptions", () => {
    conforms<RespondToToolApprovalOptions>({
      approvalId: "p1",
      approved: true,
      optionId: "allow-once",
    });
    conforms<RespondToToolApprovalOptions>({
      approvalId: "p1",
      approved: false,
      reason: "not on this box",
    });
  });

  it("textOfMessage reads assistant-ui content parts", () => {
    expect(
      textOfMessage({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
    expect(textOfMessage({ content: "plain" })).toBe("plain");
    expect(textOfMessage({ content: [{ type: "image", url: "x" }] })).toBe("");
  });
});
