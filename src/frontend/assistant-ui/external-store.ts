/**
 * `createExternalStoreAdapter` — the main route for agent CLIs.
 *
 * ```tsx
 * const store = createThreadStore({ transport });
 * useExternalStoreRuntime(createExternalStoreAdapter(store));
 * ```
 *
 * Why this one over `useLocalRuntime` for a coding agent: two of its features
 * are real server-side calls, not client state.
 *
 * - **Approval gates** (`permission_request` → `onRespondToToolApproval`)
 *   round-trip to `run.respondToPermission`, so the Allow / Deny click
 *   unblocks the agent rather than only the UI. Rolled back if the answer
 *   cannot be delivered.
 * - **Cancel** (`onCancel`) is a server interrupt; the stream ends with a
 *   terminal `done`, not a closed socket.
 *
 * ## Deliberately NOT wired: edit, regenerate, branching
 *
 * `onEdit`, `onReload` and `onResume` are absent on purpose, and assistant-ui
 * reads that as "this app cannot edit / regenerate" — so the buttons do not
 * appear. That is the honest state, because wiring them would be a lie:
 *
 * Every resume path in every supported CLI only *extends* a session — there is
 * no flag to truncate a prefix (`docs/PARITY.md` §4, "Truncating a
 * conversation"). So "edit this message and re-ask" would send only the new
 * text to an agent that still holds the old transcript, and "regenerate" would
 * append a second answer instead of replacing the first. Both look correct in
 * the UI and are wrong about the agent's context. The same gap is why
 * assistant-ui's Checkpoints element is out of reach.
 *
 * A UI that genuinely needs them should start a fresh `Session` (or a fresh
 * session key) rather than pretend the old context is gone.
 *
 * The store is framework-free on purpose (`getSnapshot`/`subscribe`), so it
 * binds to React's `useSyncExternalStore`, zustand, or a hand-rolled
 * `useState` without this package depending on any of them.
 */

import { RuntimeError, RuntimeSessionError } from "../../core/errors.js";
import type { AssistantTurn } from "./fold.js";
import { createAssistantTurn } from "./fold.js";
import type { RuntimeTransport } from "./transport.js";
import type {
  AuiExternalPart,
  AuiInboundMessage,
  AuiLoadState,
  AuiRunState,
  AuiThreadMessageLike,
  AuiTurnSnapshot,
  AuiUnhandledEvent,
} from "./types.js";

export interface ThreadStoreSnapshot {
  readonly messages: readonly AuiThreadMessageLike[];
  /** assistant-ui's flag: true while streaming OR while cancelling. */
  readonly isRunning: boolean;
  /** Native agent session id once `session_started` arrived — the resume handle. */
  readonly nativeSessionId: string | undefined;
  /**
   * Whether the thread has anything to show, and if not, why. Without this,
   * "nothing sent yet", "first turn in flight" and "backend unreachable" all
   * render as the same empty thread.
   */
  readonly loadState: AuiLoadState;
  /** Run lifecycle. `cancelling` is separate — the agent keeps emitting until `done`. */
  readonly runState: AuiRunState;
  /** Diagnostics for the live/last turn, straight from the fold. */
  readonly droppedParts: number;
  readonly unhandledEvents: readonly AuiUnhandledEvent[];
}

export interface ThreadStore {
  getSnapshot(): ThreadStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Send a user turn and stream it. Rejects if a run is already live. */
  send(text: string): Promise<void>;
  /** Stop the live turn (`onCancel`). */
  cancel(): Promise<void>;
  /** Answer a pending approval (`onRespondToToolApproval`). */
  respondToApproval(options: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    optionId?: string;
  }): Promise<void>;
  /** Inject a structured `data-*` part into the live turn (the `data-*` channel). */
  emit(part: AuiExternalPart): void;
  /**
   * Replace the message array (branch switching, `setMessages`).
   *
   * Takes the permissive inbound shape: assistant-ui may hand back messages
   * carrying parts this package never emits, and they are stored and
   * re-broadcast without being inspected.
   */
  setMessages(messages: readonly AuiInboundMessage[]): void;
  /** Seed history (e.g. from `session.history()`), read-only. */
  seed(messages: readonly AuiThreadMessageLike[]): void;
  /** Drop everything and start over (`onNew` on a fresh thread). */
  reset(): void;
}

export interface ThreadStoreOptions {
  readonly transport: RuntimeTransport;
  /** Injectable id source so tests stay deterministic. */
  readonly newId?: () => string;
  /** Injectable clock so `createdAt` is deterministic in tests. */
  readonly now?: () => Date;
}

let idCounter = 0;

function defaultId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function turnToMessage(
  snapshot: AuiTurnSnapshot,
  id: string,
  createdAt: Date,
): AuiThreadMessageLike {
  const usage = snapshot.usage;
  const steps =
    usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? [{ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }]
      : undefined;
  return {
    role: "assistant",
    id,
    createdAt,
    content: snapshot.parts,
    status: snapshot.status,
    metadata: {
      ...(steps !== undefined ? { steps } : {}),
      // Publish the fold's counters instead of making every consumer
      // recompute them; assistant-ui already has MessageTiming consumers.
      timing: snapshot.timing,
      custom: {
        ...(snapshot.nativeSessionId !== undefined
          ? { nativeSessionId: snapshot.nativeSessionId }
          : {}),
        ...(snapshot.error !== undefined
          ? { errorCode: snapshot.error.code, errorMessage: snapshot.error.message }
          : {}),
        cancelled: snapshot.cancelled,
        textChars: snapshot.textChars,
        chunks: snapshot.chunks,
        ...(snapshot.droppedParts > 0 ? { droppedParts: snapshot.droppedParts } : {}),
        ...(snapshot.unhandledEvents.length > 0
          ? {
              unhandledEvents: snapshot.unhandledEvents.map((e) => ({
                type: e.type,
                count: e.count,
              })),
            }
          : {}),
      },
    },
  };
}

export function createThreadStore(options: ThreadStoreOptions): ThreadStore {
  const { transport } = options;
  const newId = options.newId ?? ((): string => defaultId("msg"));
  const now = options.now ?? ((): Date => new Date());

  let messages: readonly AuiThreadMessageLike[] = [];
  let nativeSessionId: string | undefined;
  let loadState: AuiLoadState = { type: "idle" };
  let runState: AuiRunState = { type: "idle" };
  let droppedParts = 0;
  let unhandledEvents: readonly AuiUnhandledEvent[] = [];
  /**
   * The current turn, RETAINED after it drains. A `permission_request` can
   * land on the last event before `done`, and the user's Allow / Deny click
   * arrives after the run has already settled — dropping the turn here would
   * leave the gate card stuck on `requires-action` forever.
   */
  let turn: AssistantTurn | undefined;
  /** The message the retained turn writes into. */
  let assistantMessageId: string | undefined;
  let runId: string | undefined;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();

  function buildSnapshot(): ThreadStoreSnapshot {
    const busy = runState.type === "streaming" || runState.type === "cancelling";
    return {
      messages,
      isRunning: busy,
      nativeSessionId,
      loadState,
      runState,
      droppedParts,
      unhandledEvents,
    };
  }

  let snapshot: ThreadStoreSnapshot = buildSnapshot();

  function commit(next: Partial<ThreadStoreSnapshot>): void {
    messages = next.messages ?? messages;
    nativeSessionId = next.nativeSessionId ?? nativeSessionId;
    loadState = next.loadState ?? loadState;
    runState = next.runState ?? runState;
    droppedParts = next.droppedParts ?? droppedParts;
    unhandledEvents = next.unhandledEvents ?? unhandledEvents;
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  function replaceMessage(id: string, message: AuiThreadMessageLike): void {
    commit({ messages: messages.map((m) => (m.id === id ? message : m)) });
  }

  /** Lift the fold's diagnostics into the store snapshot, where a host reads them. */
  function absorbFold(snap: AuiTurnSnapshot): void {
    droppedParts = snap.droppedParts;
    unhandledEvents = snap.unhandledEvents;
  }

  /** Re-publish the retained turn into the message it belongs to. */
  function republish(): void {
    if (turn === undefined || assistantMessageId === undefined) return;
    const live = messages.find((m) => m.id === assistantMessageId);
    if (live === undefined) return;
    absorbFold(turn.snapshot());
    replaceMessage(
      assistantMessageId,
      turnToMessage(turn.snapshot(), assistantMessageId, live.createdAt ?? now()),
    );
  }

  return {
    getSnapshot(): ThreadStoreSnapshot {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async send(text: string): Promise<void> {
      if (text.length === 0) throw new RuntimeSessionError("send(): empty prompt", {});
      // One active run per session: a second turn rejects loudly rather than
      // silently opening a parallel run that would lose context.
      if (snapshot.isRunning) {
        throw new RuntimeSessionError(
          "send(): a turn is already streaming — drain it to `done` before starting another",
          {},
        );
      }

      const userId = newId();
      const assistantId = newId();
      const createdAt = now();
      commit({
        messages: [
          ...messages,
          { role: "user", id: userId, createdAt, content: [{ type: "text", text }] },
          {
            role: "assistant",
            id: assistantId,
            createdAt,
            content: [],
            status: { type: "running" },
          },
        ],
        // Optimistic pair exists but nothing has arrived from the backend yet.
        loadState: { type: "loading" },
        runState: { type: "streaming" },
        droppedParts: 0,
        unhandledEvents: [],
      });

      turn = createAssistantTurn();
      assistantMessageId = assistantId;
      controller = new AbortController();
      let lastSnapshot: AuiTurnSnapshot = turn.snapshot();
      try {
        const started = await transport.startTurn(text, { signal: controller.signal });
        for await (const event of started.events) {
          if (event.runId !== undefined) runId = event.runId;
          turn.apply(event);
          lastSnapshot = turn.snapshot();
          absorbFold(lastSnapshot);
          if (lastSnapshot.nativeSessionId !== undefined) {
            commit({ nativeSessionId: lastSnapshot.nativeSessionId });
          }
          // First event has landed: there is genuinely something to show.
          if (loadState.type === "loading") commit({ loadState: { type: "ready" } });
          replaceMessage(assistantId, turnToMessage(lastSnapshot, assistantId, createdAt));
          if (event.type === "done") break;
        }
      } catch (err) {
        turn.markCancelled();
        replaceMessage(assistantId, turnToMessage(turn.snapshot(), assistantId, createdAt));
        // Distinguish "the backend refused / is unreachable" from "the turn
        // produced nothing" — without this both render as an empty thread.
        commit({
          loadState: { type: "error", error: err },
          runState: { type: "error", error: err },
        });
        throw err;
      } finally {
        // A stream cut before `done` must not leave a message stuck running.
        if (lastSnapshot.status.type === "running") {
          turn.markCancelled();
          replaceMessage(assistantId, turnToMessage(turn.snapshot(), assistantId, createdAt));
        }
        // Settle: back to idle unless the catch above already parked an error
        // state, and make sure `ready` is recorded even for an empty turn.
        if (runState.type !== "error") {
          commit({ runState: { type: "idle" }, loadState: { type: "ready" } });
        }
        controller = undefined;
        runId = undefined;
      }
    },

    async cancel(): Promise<void> {
      if (!snapshot.isRunning || turn === undefined) return;
      turn.markCancelled();
      republish();
      // The agent keeps streaming until its terminal `done`; "cancelling" says
      // so instead of leaving the UI on "generating" for that whole window.
      commit({ runState: { type: "cancelling" } });
      await transport.cancel(runId);
    },

    async respondToApproval(answer): Promise<void> {
      const { approvalId, approved, reason, optionId } = answer;
      // Resolve the gate locally FIRST so the card flips on the click rather
      // than after a round trip — then roll back if the answer could not be
      // delivered. Without the rollback a failed POST leaves the card reading
      // "allowed" while the agent is still parked, which is the worst of both.
      const settledLocally =
        turn?.resolveApproval(approvalId, {
          approved,
          ...(optionId !== undefined ? { optionId } : {}),
          ...(reason !== undefined ? { reason } : {}),
        }) === true;
      if (settledLocally) republish();
      try {
        await transport.respondToPermission(
          approvalId,
          optionId ?? (approved ? "allow" : "reject"),
        );
      } catch (err) {
        if (turn?.reopenApproval(approvalId) === true) republish();
        throw err;
      }
    },

    emit(part: AuiExternalPart): void {
      if (turn === undefined || !snapshot.isRunning) {
        throw new RuntimeError(
          "emit(): no live turn — structured parts attach to the streaming message",
          {},
        );
      }
      turn.emit(part);
      republish();
    },

    setMessages(next: readonly AuiInboundMessage[]): void {
      // The one documented cast in this package. Inbound messages may carry
      // parts we do not model (image/file/source/…); narrowing them to our
      // emit shape would be a lie about what we produced, so they are stored
      // opaquely instead. `AuiInboundMessage` is deliberately a supertype of
      // assistant-ui's `ThreadMessageLike`, which is what makes this sound.
      commit({ messages: next as readonly AuiThreadMessageLike[] });
    },

    seed(next: readonly AuiThreadMessageLike[]): void {
      commit({ messages: next });
    },

    reset(): void {
      controller?.abort();
      turn = undefined;
      assistantMessageId = undefined;
      runId = undefined;
      commit({
        messages: [],
        runState: { type: "idle" },
        loadState: { type: "idle" },
        droppedParts: 0,
        unhandledEvents: [],
      });
    },
  };
}

/**
 * Structural subset of assistant-ui's `ExternalStoreAdapter`, assignable to
 * it — `tests/assistant-ui-conformance.test.ts` proves that at compile time.
 *
 * Only the callbacks we can honour are present. assistant-ui enables a UI
 * feature per callback, so an absent one means the feature is off, not broken.
 */
export interface AuiExternalStoreAdapter {
  messages: readonly AuiThreadMessageLike[];
  convertMessage: (message: AuiInboundMessage) => AuiThreadMessageLike;
  isRunning: boolean;
  onNew: (message: { content: unknown }) => Promise<void>;
  onCancel: () => Promise<void>;
  onRespondToToolApproval: (options: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    optionId?: string;
  }) => Promise<void>;
  setMessages: (messages: readonly AuiInboundMessage[]) => void;
}

/**
 * Structural subset of assistant-ui's `ExternalStoreAdapter`, assignable to
 * it — `tests/assistant-ui-conformance.test.ts` proves that at compile time.
 *
 * `onEdit` / `onReload` / `onResume` are absent on purpose, and
 * `onAddToolResult` too (it exists for CLIENT-executed tools; every tool here
 * runs inside the agent's own process, so the backend already holds the
 * result). See the header comment for why the first two cannot honestly be
 * supported yet.
 */
export function createExternalStoreAdapter(store: ThreadStore): AuiExternalStoreAdapter {
  return {
    get messages(): readonly AuiThreadMessageLike[] {
      return store.getSnapshot().messages;
    },
    // We already produce `ThreadMessageLike`, so conversion is identity —
    // this is what lets the fold's output reach the primitives untouched.
    convertMessage: (message: AuiInboundMessage): AuiThreadMessageLike =>
      message as AuiThreadMessageLike,
    get isRunning(): boolean {
      return store.getSnapshot().isRunning;
    },
    onNew: async (message: { content: unknown }): Promise<void> => {
      await store.send(textOfContent(message.content));
    },
    onCancel: async (): Promise<void> => {
      await store.cancel();
    },
    onRespondToToolApproval: async (options): Promise<void> => {
      await store.respondToApproval(options);
    },
    setMessages: (messages: readonly AuiInboundMessage[]): void => {
      store.setMessages(messages);
    },
  };
}

/** Same extraction as `chat-model.ts`'s `textOfMessage`, kept local to avoid a cross-import. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}
