import { describe, expect, it, vi } from "vitest";
import { RuntimeProtocolError, RuntimeSessionError } from "../src/core/errors.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import { createAssistantTurn } from "../src/frontend/assistant-ui/fold.js";
import { createChatModelAdapter } from "../src/frontend/assistant-ui/chat-model.js";
import {
  createExternalStoreAdapter,
  createThreadStore,
  type ThreadStore,
} from "../src/frontend/assistant-ui/external-store.js";
import { createRuntimeTransport } from "../src/frontend/assistant-ui/transport.js";
import type {
  AuiExternalPart,
  AuiThreadMessageLike,
  AuiToolCallPart,
} from "../src/frontend/assistant-ui/types.js";
import { encodeRuntimeEvent } from "../src/wire.js";

/* ------------------------------------------------------------------ helpers */

/** A `Response`-alike whose body replays `body` as SSE `data:` lines. */
function sseResponse(
  events: readonly RuntimeEvent[],
  init?: { ok?: boolean; status?: number },
): Response {
  const body = events.map((e) => `data: ${encodeRuntimeEvent(e)}`).join("");
  const bytes = new TextEncoder().encode(body);
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: "OK",
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: () => {
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          releaseLock: () => {},
        };
      },
    },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Emits `head` immediately, then waits on `gate` before emitting `tail`. */
function gatedSseResponse(
  head: readonly RuntimeEvent[],
  tail: readonly RuntimeEvent[],
  gate: Promise<void>,
): Response {
  const encode = (events: readonly RuntimeEvent[]): Uint8Array =>
    new TextEncoder().encode(events.map((e) => `data: ${encodeRuntimeEvent(e)}`).join(""));
  const headBytes = encode(head);
  const tailBytes = encode(tail);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader: () => {
        let phase = 0;
        return {
          read: async () => {
            if (phase === 0) {
              phase = 1;
              return Promise.resolve({ done: false, value: headBytes });
            }
            if (phase === 1) {
              await gate;
              phase = 2;
              return Promise.resolve({ done: false, value: tailBytes });
            }
            return Promise.resolve({ done: true });
          },
          releaseLock: () => {},
        };
      },
    },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

/** Poll until `predicate` holds (no timers in the fake streams). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("waitFor: condition never held");
}

interface FetchCall {
  url: string;
  body: unknown;
}

/** Records every POST and answers the turn route from a scripted event list. */
function fakeFetch(script: {
  turn?: (body: unknown) => Response;
  calls?: FetchCall[];
  /** Route suffixes that must fail, e.g. to exercise the approval rollback. */
  failing?: readonly string[];
}): typeof globalThis.fetch {
  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body;
    const body = typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
    script.calls?.push({ url, body });
    let response: Response;
    if (script.failing?.some((suffix) => url.endsWith(suffix)) === true) {
      response = sseResponse([], { ok: false, status: 500 });
    } else if (url.endsWith("/turn")) {
      response = script.turn?.(body) ?? sseResponse([{ type: "done", exitCode: 0 }]);
    } else {
      response = {
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(""),
      } as unknown as Response;
    }
    return Promise.resolve(response);
  };
}

function transportOf(events: readonly RuntimeEvent[], calls?: FetchCall[]) {
  return createRuntimeTransport({
    endpoints: { turn: "/turn", cancel: "/cancel", permission: "/permission", send: "/send" },
    fetch: fakeFetch({
      turn: () => sseResponse(events),
      ...(calls !== undefined ? { calls } : {}),
    }),
  });
}

const RUN = "sess_a:run1";

const TURN: RuntimeEvent[] = [
  { type: "session_started", sessionId: "native-1", runId: RUN },
  { type: "text_delta", text: "Hel", runId: RUN },
  { type: "text_delta", text: "lo", runId: RUN },
  { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01, model: "sonnet", runId: RUN },
  { type: "done", exitCode: 0, runId: RUN },
];

function lastAssistant(store: ThreadStore): AuiThreadMessageLike {
  const messages = store.getSnapshot().messages;
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant") throw new Error("no assistant message");
  return last;
}

function partsOf(message: AuiThreadMessageLike): readonly AuiExternalPart[] {
  // `content` is `string | readonly AuiExternalPart[]` (assistant-ui allows a
  // bare string); we always emit parts.
  return typeof message.content === "string" ? [] : message.content;
}

function toolCall(message: AuiThreadMessageLike): AuiToolCallPart | undefined {
  return partsOf(message).find((p): p is AuiToolCallPart => p.type === "tool-call");
}

function makeStore(events: readonly RuntimeEvent[], calls?: FetchCall[]): ThreadStore {
  let n = 0;
  return createThreadStore({
    transport: transportOf(events, calls),
    newId: () => `m${String((n += 1))}`,
    now: () => new Date(0),
  });
}

/* ---------------------------------------------------------------- transport */

describe("transport", () => {
  it("posts the prompt and streams the turn's events", async () => {
    const calls: FetchCall[] = [];
    const transport = transportOf(TURN, calls);
    const turn = await transport.startTurn("hello");
    const seen: RuntimeEvent[] = [];
    for await (const event of turn.events) seen.push(event);
    expect(calls[0]?.url).toBe("/turn");
    expect(calls[0]?.body).toEqual({ prompt: "hello" });
    expect(seen).toEqual(TURN);
    expect(turn.runId).toBe(RUN);
  });

  it("forwards the session key so the backend can reuse its Session", async () => {
    const calls: FetchCall[] = [];
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      sessionId: "sess_x",
      fetch: fakeFetch({ calls }),
    });
    await transport.startTurn("hi");
    expect(calls[0]?.body).toEqual({ prompt: "hi", session: "sess_x" });
  });

  it("rejects an empty prompt before touching the network", async () => {
    const transport = transportOf(TURN);
    await expect(transport.startTurn("")).rejects.toThrow(TypeError);
  });

  it("throws loudly when the turn route answers 409 (a run is already live)", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({
        turn: () => sseResponse([], { ok: false, status: 409 }),
      }),
    });
    // Draining before the next turn is the backend's rule; the UI surfaces it.
    await expect(transport.startTurn("hi")).rejects.toThrow(RuntimeProtocolError);
  });

  it("truncates the error envelope so a prompt echo can never leak", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({
        turn: () => sseResponse([], { ok: false, status: 500 }),
      }),
    });
    await expect(transport.startTurn("hi")).rejects.toThrow(/500/);
  });

  it("throws when a successful turn carries no body", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({
        turn: () =>
          ({ ok: true, status: 200, statusText: "OK", body: null }) as unknown as Response,
      }),
    });
    const turn = await transport.startTurn("hi");
    await expect(async () => {
      for await (const event of turn.events) {
        expect(event.type).toBeTypeOf("string");
      }
    }).rejects.toThrow(RuntimeProtocolError);
  });

  it("throws when an unconfigured endpoint is used", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({}),
    });
    await expect(transport.cancel()).rejects.toThrow(TypeError);
    await expect(transport.respondToPermission("p1", "allow")).rejects.toThrow(TypeError);
    await expect(transport.send(RUN, "steer")).rejects.toThrow(TypeError);
  });

  it("posts WireSendInput for mid-run steering", async () => {
    const calls: FetchCall[] = [];
    const transport = transportOf(TURN, calls);
    await transport.send(RUN, "use pnpm");
    expect(calls[0]).toEqual({ url: "/send", body: { runId: RUN, text: "use pnpm" } });
  });

  it("posts WireRespondPermission for an approval answer", async () => {
    const calls: FetchCall[] = [];
    const transport = transportOf(TURN, calls);
    await transport.respondToPermission("p1", "allow-once");
    expect(calls[0]).toEqual({ url: "/permission", body: { id: "p1", optionId: "allow-once" } });
  });

  it("requires a turn endpoint and a fetch", () => {
    expect(() => createRuntimeTransport({ endpoints: { turn: "" }, fetch: fakeFetch({}) })).toThrow(
      TypeError,
    );
    expect(() =>
      createRuntimeTransport({ endpoints: { turn: "/turn" }, fetch: undefined }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------ thread store */

describe("threadStore", () => {
  it("appends a user message and a streaming assistant message", async () => {
    const store = makeStore(TURN);
    await store.send("hello");
    const snapshot = store.getSnapshot();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({ role: "user" });
    expect(snapshot.isRunning).toBe(false);
    expect(snapshot.nativeSessionId).toBe("native-1");
    expect(lastAssistant(store)).toMatchObject({ status: { type: "complete", reason: "stop" } });
  });

  it("accumulates streamed text into one text part", async () => {
    const store = makeStore(TURN);
    await store.send("hello");
    expect(lastAssistant(store).content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("notifies subscribers as the turn streams", async () => {
    const store = makeStore(TURN);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.send("hello");
    expect(listener.mock.calls.length).toBeGreaterThan(1);
    store.subscribe(() => {})();
  });

  it("unsubscribes cleanly", async () => {
    const store = makeStore(TURN);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    await store.send("hello");
    expect(listener).not.toHaveBeenCalled();
  });

  it("puts usage on metadata.steps for the cost meter", async () => {
    const store = makeStore(TURN);
    await store.send("hello");
    expect(lastAssistant(store).metadata?.steps).toEqual([
      { usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("rejects a second turn while one is streaming (one active run per session)", async () => {
    const store = makeStore(TURN);
    const first = store.send("hello");
    await expect(store.send("again")).rejects.toThrow(RuntimeSessionError);
    await first;
  });

  it("rejects an empty prompt", async () => {
    const store = makeStore(TURN);
    await expect(store.send("")).rejects.toThrow(RuntimeSessionError);
  });

  it("settles a cut stream as cancelled rather than stuck running", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({
        turn: () => sseResponse([{ type: "text_delta", text: "partial", runId: RUN }]),
      }),
    });
    const store = createThreadStore({ transport, newId: () => "m", now: () => new Date(0) });
    await store.send("hi");
    // No `done` arrived — the message must not read as still generating.
    expect(lastAssistant(store).status).toEqual({ type: "incomplete", reason: "cancelled" });
    expect(store.getSnapshot().isRunning).toBe(false);
  });

  it("surfaces an error code on the message status", async () => {
    const transport = createRuntimeTransport({
      endpoints: { turn: "/turn" },
      fetch: fakeFetch({
        turn: () =>
          sseResponse([
            { type: "text_delta", text: "x", runId: RUN },
            { type: "error", error: { code: "STALL", message: "silent" }, runId: RUN },
            { type: "done", runId: RUN },
          ]),
      }),
    });
    const store = createThreadStore({ transport, newId: () => "m", now: () => new Date(0) });
    await store.send("hi");
    const message = lastAssistant(store);
    expect(message.status).toMatchObject({ type: "incomplete", reason: "error" });
    expect(message.metadata?.custom?.["errorCode"]).toBe("STALL");
  });

  it("emits a data-* part into the live turn", async () => {
    // A body that holds the stream open after the first event, so `emit` is
    // provably attaching to a LIVE turn rather than a finished one.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn" },
        fetch: fakeFetch({
          turn: () =>
            gatedSseResponse(
              [{ type: "text_delta", text: "report:", runId: RUN }],
              [{ type: "done", runId: RUN }],
              gate,
            ),
        }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    const pending = store.send("hi");
    // Wait for the text_delta to land — the optimistic message pair exists
    // before any event does, so length alone would race.
    await waitFor(() => partsOf(lastAssistant(store)).length > 0);
    store.emit({ type: "data-spec-sheet", data: { title: "Q3" } });
    release();
    await pending;
    expect(lastAssistant(store).content).toBeDefined();
    expect(partsOf(lastAssistant(store)).map((p) => p.type)).toEqual(["text", "data-spec-sheet"]);
  });

  it("refuses to emit a data part with no live turn", () => {
    const store = makeStore(TURN);
    expect(() => {
      store.emit({ type: "data-x", data: 1 });
    }).toThrow(/no live turn/);
  });

  it("setMessages / seed / reset drive the array", () => {
    const store = makeStore(TURN);
    const seeded: AuiThreadMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "old" }] },
    ];
    store.seed(seeded);
    expect(store.getSnapshot().messages).toBe(seeded);
    store.setMessages([]);
    expect(store.getSnapshot().messages).toHaveLength(0);
    store.reset();
    expect(store.getSnapshot().isRunning).toBe(false);
  });
});

/* ------------------------------------------------- permissions over the wire */

describe("threadStore — approval gates", () => {
  const ASK: RuntimeEvent[] = [
    {
      type: "permission_request",
      id: "p1",
      toolName: "Bash",
      prompt: "run rm?",
      options: [{ optionId: "allow-once", kind: "allow_once", label: "Allow" }],
      runId: RUN,
    },
    { type: "done", runId: RUN },
  ];

  it("routes the Allow click to the backend and clears the gate", async () => {
    const calls: FetchCall[] = [];
    const store = makeStore(ASK, calls);
    await store.send("delete everything");
    expect(lastAssistant(store).status).toEqual({ type: "requires-action", reason: "tool-calls" });

    await store.respondToApproval({ approvalId: "p1", approved: true, optionId: "allow-once" });
    expect(calls.at(-1)).toEqual({
      url: "/permission",
      body: { id: "p1", optionId: "allow-once" },
    });
    expect(lastAssistant(store).status).not.toMatchObject({ type: "requires-action" });
  });

  it("marks the tool call denied on a Deny click", async () => {
    const store = makeStore(ASK);
    await store.send("delete everything");
    await store.respondToApproval({ approvalId: "p1", approved: false, optionId: "reject-once" });
    const call = toolCall(lastAssistant(store));
    expect(call?.approval?.approved).toBe(false);
    expect(call?.isError).toBe(true);
  });

  it("still forwards the answer when the gate is unknown locally", async () => {
    const calls: FetchCall[] = [];
    const store = makeStore(ASK, calls);
    // A permission_request that arrived before the UI mounted: the backend
    // answer must go out regardless of what the client fold knows.
    await store.respondToApproval({ approvalId: "p-elsewhere", approved: true });
    expect(calls.at(-1)).toEqual({
      url: "/permission",
      body: { id: "p-elsewhere", optionId: "allow" },
    });
  });

  it("re-opens the gate when the answer cannot be delivered", async () => {
    // Optimistic-then-POST with no rollback would leave the card reading
    // "allowed" while the agent is still parked — the worst of both worlds.
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn", permission: "/permission" },
        fetch: fakeFetch({ turn: () => sseResponse(ASK), failing: ["/permission"] }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    await store.send("delete everything");
    expect(lastAssistant(store).status).toEqual({ type: "requires-action", reason: "tool-calls" });

    await expect(
      store.respondToApproval({ approvalId: "p1", approved: true, optionId: "allow-once" }),
    ).rejects.toThrow(RuntimeProtocolError);

    // Rolled back: still gated, no approval recorded, no error result.
    const call = toolCall(lastAssistant(store));
    expect(call?.approval?.approved).toBeUndefined();
    expect(call?.isError).toBeUndefined();
    expect(lastAssistant(store).status).toEqual({ type: "requires-action", reason: "tool-calls" });
  });

  it("re-opens a DENIED gate without leaving the synthesized error behind", () => {
    const turn = createAssistantTurn();
    turn.apply({
      type: "permission_request",
      id: "p1",
      options: [{ optionId: "no", kind: "reject_once" }],
    });
    turn.resolveApproval("p1", { approved: false, optionId: "no" });
    expect(toolCallOf(turn.snapshot().parts)?.result).toBeDefined();

    expect(turn.reopenApproval("p1")).toBe(true);
    const call = toolCallOf(turn.snapshot().parts);
    // The gate is pending again (not deleted — the question still stands), the
    // synthesized denial error is gone, and the status waits on the user.
    expect(call?.approval?.approved).toBeUndefined();
    expect(call?.result).toBeUndefined();
    expect(call?.isError).toBeUndefined();
    expect(turn.snapshot().status).toEqual({ type: "requires-action", reason: "tool-calls" });
  });

  it("keeps the prompt and options when a denied gate is re-opened", () => {
    const turn = createAssistantTurn();
    turn.apply({
      type: "permission_request",
      id: "p1",
      prompt: "run rm?",
      options: [
        { optionId: "yes", kind: "allow_once" },
        { optionId: "no", kind: "reject_once" },
      ],
    });
    turn.resolveApproval("p1", { approved: false, optionId: "no", reason: "nope" });
    turn.reopenApproval("p1");
    expect(toolCallOf(turn.snapshot().parts)?.approval).toEqual({
      id: "p1",
      prompt: "run rm?",
      options: [
        { id: "yes", kind: "allow-once" },
        { id: "no", kind: "reject-once" },
      ],
    });
  });

  it("returns false when re-opening an unknown gate", () => {
    expect(createAssistantTurn().reopenApproval("nope")).toBe(false);
  });
});

function toolCallOf(parts: readonly unknown[]): AuiToolCallPart | undefined {
  return parts.find((p): p is AuiToolCallPart => (p as { type?: unknown }).type === "tool-call");
}

/* ------------------------------------------------ load / run state machine */

describe("threadStore — loadState & runState", () => {
  it("starts idle with nothing running", () => {
    const store = makeStore(TURN);
    expect(store.getSnapshot().loadState).toEqual({ type: "idle" });
    expect(store.getSnapshot().runState).toEqual({ type: "idle" });
    expect(store.getSnapshot().isRunning).toBe(false);
  });

  it("reports loading before the first event, ready after", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn" },
        fetch: fakeFetch({ turn: () => gatedSseResponse([], TURN, gate) }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    const pending = store.send("hi");
    // Optimistic pair exists but nothing has streamed yet.
    expect(store.getSnapshot().loadState).toEqual({ type: "loading" });
    expect(store.getSnapshot().runState).toEqual({ type: "streaming" });
    expect(store.getSnapshot().isRunning).toBe(true);

    release();
    await pending;
    expect(store.getSnapshot().loadState).toEqual({ type: "ready" });
    expect(store.getSnapshot().runState).toEqual({ type: "idle" });
    expect(store.getSnapshot().isRunning).toBe(false);
  });

  it("distinguishes 'backend unreachable' from 'empty thread'", async () => {
    // Without this, a 409 / 500 / dead BFF renders identically to a thread
    // the user simply has not written in yet.
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn" },
        fetch: fakeFetch({ turn: () => sseResponse([], { ok: false, status: 409 }) }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    await expect(store.send("hi")).rejects.toThrow(RuntimeProtocolError);
    const snap = store.getSnapshot();
    expect(snap.loadState.type).toBe("error");
    expect(snap.runState.type).toBe("error");
    // `isRunning` must be false — an errored run is not still running.
    expect(snap.isRunning).toBe(false);
  });

  it("marks cancelling between Stop and the terminal done", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: FetchCall[] = [];
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn", cancel: "/cancel" },
        fetch: fakeFetch({
          turn: () => gatedSseResponse(TURN.slice(0, 2), TURN.slice(2), gate),
          calls,
        }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    const pending = store.send("hi");
    await waitFor(() => store.getSnapshot().runState.type === "streaming");

    const cancelling = store.cancel();
    // The agent keeps streaming until its terminal `done`; reporting
    // "generating" for that whole window is wrong.
    expect(store.getSnapshot().runState).toEqual({ type: "cancelling" });
    // assistant-ui still needs isRunning=true so the Stop button stays put.
    expect(store.getSnapshot().isRunning).toBe(true);

    release();
    await cancelling;
    await pending;
    expect(store.getSnapshot().runState).toEqual({ type: "idle" });
    expect(calls.some((c) => c.url === "/cancel")).toBe(true);
  });

  it("cancel is a no-op with no live turn", async () => {
    const store = makeStore(TURN);
    await store.cancel();
    expect(store.getSnapshot().runState).toEqual({ type: "idle" });
  });

  it("keeps the whole turn when a line cannot be decoded, and reports it", async () => {
    // Correction to an earlier assumption of mine: an unknown event type does
    // NOT kill the turn. The decoders fail open (the library's own promise
    // for a growing event set) and route the loss to `onProtocolError`.
    const errors: RuntimeProtocolError[] = [];
    const store = createThreadStore({
      transport: createRuntimeTransport({
        endpoints: { turn: "/turn" },
        onProtocolError: (e) => errors.push(e),
        fetch: fakeFetch({
          turn: () =>
            sseResponse([
              { type: "text_delta", text: "before", runId: RUN },
              { type: "quantum_flux" } as unknown as RuntimeEvent,
              { type: "text_delta", text: " after", runId: RUN },
              { type: "done", runId: RUN },
            ]),
        }),
      }),
      newId: () => "m",
      now: () => new Date(0),
    });
    await store.send("hi");
    // Nothing on either side of the poison line was lost.
    expect(textOf(partsOf(lastAssistant(store)))).toBe("before after");
    expect(lastAssistant(store).status).toEqual({ type: "complete", reason: "stop" });
    expect(errors).toHaveLength(1);
    expect(store.getSnapshot().loadState).toEqual({ type: "ready" });
  });

  it("publishes the fold's diagnostics on the snapshot", () => {
    // Fold-level path (direct library callers that skip the wire decoder).
    const store = makeStore(TURN);
    const snap = store.getSnapshot();
    expect(snap.unhandledEvents).toEqual([]);
    expect(snap.droppedParts).toBe(0);
  });

  it("publishes timing on the message", async () => {
    const store = makeStore(TURN);
    await store.send("hi");
    const timing = lastAssistant(store).metadata?.timing;
    expect(timing?.totalChunks).toBe(5);
    expect(timing?.tokenCount).toBe(5);
    expect(timing?.totalStreamTime).toBeDefined();
  });

  it("clears diagnostics on reset", async () => {
    const store = makeStore([
      { type: "text_delta", text: "a", runId: RUN },
      { type: "done", runId: RUN },
    ]);
    await store.send("hi");
    store.reset();
    const snap = store.getSnapshot();
    expect(snap.messages).toHaveLength(0);
    expect(snap.loadState).toEqual({ type: "idle" });
    expect(snap.runState).toEqual({ type: "idle" });
    expect(snap.unhandledEvents).toEqual([]);
  });
});

/* ------------------------------------------------ external store projection */

describe("externalStoreAdapter", () => {
  it("projects the store into assistant-ui's adapter shape", async () => {
    const store = makeStore(TURN);
    const adapter = createExternalStoreAdapter(store);
    expect(adapter.isRunning).toBe(false);
    expect(adapter.messages).toEqual([]);
    expect(adapter.convertMessage({ role: "user", content: [] })).toEqual({
      role: "user",
      content: [],
    });

    await adapter.onNew({ content: [{ type: "text", text: "hello" }] });
    expect(adapter.messages).toHaveLength(2);
    expect(textOf(adapter.messages[0]?.content)).toBe("hello");
  });

  it("still derives isRunning for assistant-ui from the richer runState", () => {
    const store = makeStore(TURN);
    const adapter = createExternalStoreAdapter(store);
    expect(adapter.isRunning).toBe(false);
  });

  it("cancels through to the backend", async () => {
    const calls: FetchCall[] = [];
    const adapter = createExternalStoreAdapter(makeStore(TURN, calls));
    await adapter.onCancel();
    // No live turn — nothing to stop, so no request is made.
    expect(calls).toHaveLength(0);
  });

  it("omits onAddToolResult (tools run inside the agent's own process)", () => {
    const adapter = createExternalStoreAdapter(makeStore(TURN));
    // Leaving the callback off keeps the client-executed-tool capability off,
    // which is the honest state: the backend already holds every result.
    expect("onAddToolResult" in adapter).toBe(false);
  });
});

function textOf(parts: readonly unknown[] | string | undefined): string {
  if (typeof parts === "string") return parts;
  return (parts ?? [])
    .map((p) => p as { type?: string; text?: string })
    .filter((p) => p.type === "text")
    .map((p) => String(p.text))
    .join("");
}

/* ------------------------------------------------------------ chat adapter */

describe("createChatModelAdapter", () => {
  async function collect(text: string, events: readonly RuntimeEvent[]): Promise<unknown[]> {
    const adapter = createChatModelAdapter({ transport: transportOf(events) });
    const out: unknown[] = [];
    const stream = adapter.run({
      messages: [{ content: [{ type: "text", text }] }],
      abortSignal: new AbortController().signal,
    });
    for await (const result of stream) out.push(result);
    return out;
  }

  it("yields the cumulative snapshot on every event (never a delta)", async () => {
    const results = (await collect("hello", TURN)) as { content?: { text?: string }[] }[];
    const texts = results.map((r) => r.content?.[0]?.text);
    expect(texts).toContain("Hel");
    expect(texts).toContain("Hello");
    expect(texts.at(-1)).toBe("Hello");
  });

  it("ends on a complete status", async () => {
    const results = (await collect("hello", TURN)) as { status?: { type: string } }[];
    expect(results.at(-1)?.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("extracts the prompt from assistant-ui message parts", async () => {
    const calls: FetchCall[] = [];
    const adapter = createChatModelAdapter({ transport: transportOf(TURN, calls) });
    for await (const result of adapter.run({
      messages: [
        {
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        },
      ],
      abortSignal: new AbortController().signal,
    })) {
      expect(result.content).toBeDefined();
    }
    expect(calls[0]?.body).toMatchObject({ prompt: "part one part two" });
  });

  it("throws when there is nothing to send", async () => {
    const adapter = createChatModelAdapter({ transport: transportOf(TURN) });
    const stream = adapter.run({ messages: [], abortSignal: new AbortController().signal });
    await expect(stream.next()).rejects.toThrow(/no user prompt/);
  });

  it("settles as cancelled when the abort signal fires mid-turn", async () => {
    const controller = new AbortController();
    const adapter = createChatModelAdapter({ transport: transportOf(TURN) });
    const results: { status?: { type: string } }[] = [];
    for await (const result of adapter.run({
      messages: [{ content: [{ type: "text", text: "hello" }] }],
      abortSignal: controller.signal,
    })) {
      results.push(result);
      controller.abort();
    }
    expect(results.at(-1)?.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });
});
