/**
 * `createChatModelAdapter` — the low-friction path into assistant-ui.
 *
 * ```tsx
 * const runtime = useLocalRuntime(createChatModelAdapter({ transport }));
 * ```
 *
 * `ChatModelAdapter.run` is an async generator yielding `ChatModelRunResult`.
 * Two rules from assistant-ui's LocalRuntime docs drive the implementation:
 *
 * 1. **Yield the cumulative snapshot, never a delta.** Each yield REPLACES the
 *    message content, so a delta would flicker. We re-yield `turn.snapshot()`
 *    on every event — cheap (the part list is short) and impossible to get
 *    wrong.
 * 2. **Only the last part may be `running`.** An empty trailing text part
 *    marks the previous part complete, so `fold.ts` never emits one.
 *
 * Cancellation is `abortSignal` → `transport.cancel()`: the composer's Stop
 * button arrives as an abort, and the backend ends the turn with a terminal
 * `done` (`docs/frontend.md` §Cancellation), which we settle as
 * `incomplete/cancelled`.
 */

import { RuntimeError } from "../../core/errors.js";
import type { AssistantTurn } from "./fold.js";
import { createAssistantTurn } from "./fold.js";
import type { RuntimeTransport } from "./transport.js";
import type {
  AuiChatModelRunResult,
  AuiDataPart,
  AuiExternalPart,
  AuiPart,
  AuiTurnSnapshot,
} from "./types.js";

export interface ChatModelAdapterOptions {
  readonly transport: RuntimeTransport;
  /** Prompt to send. Defaults to the composed text (the normal case). */
  readonly prompt?: (text: string) => string;
}

/** Structural subset of assistant-ui's `ChatModelAdapter`. */
export interface AuiChatModelAdapter {
  run(options: {
    messages: readonly { readonly content: unknown }[];
    abortSignal: AbortSignal;
    context?: unknown;
    runConfig?: unknown;
    unstable_getMessage?: () => unknown;
  }): AsyncGenerator<AuiChatModelRunResult, void, undefined>;
}

/** Pull the prompt out of an assistant-ui `AppendMessage`-shaped message. */
export function textOfMessage(message: { readonly content: unknown }): string {
  const content = message.content;
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

/**
 * Translate the fold's parts into `ChatModelRunResult`'s part union.
 *
 * Only one rewrite is needed: `ThreadAssistantMessagePart` (the local-runtime
 * path) has no `data-<name>` spelling — it wants `{ type: "data", name, data }`.
 * The external-store path accepts either, so the prefixed form is kept
 * everywhere else and converted only here.
 */
/** `AuiDataPart` and `AuiNamedDataPart` have disjoint discriminants (`data-x` vs `data`), but TypeScript cannot narrow a union on a `.startsWith()` call — hence the explicit guard. */
function isPrefixedDataPart(part: AuiExternalPart): part is AuiDataPart {
  return part.type.startsWith("data-");
}

function toRunParts(parts: readonly AuiExternalPart[]): AuiPart[] {
  return parts.map((part) =>
    isPrefixedDataPart(part)
      ? { type: "data" as const, name: part.type.slice(5), data: part.data }
      : part,
  );
}

/** Project the fold's snapshot onto `ChatModelRunResult`. */
function toRunResult(snapshot: AuiTurnSnapshot): AuiChatModelRunResult {
  const usage = snapshot.usage;
  const steps =
    usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? [{ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }]
      : undefined;
  return {
    content: toRunParts(snapshot.parts),
    status: snapshot.status,
    metadata: {
      ...(steps !== undefined ? { steps } : {}),
      timing: snapshot.timing,
      custom: {
        ...(snapshot.nativeSessionId !== undefined
          ? { nativeSessionId: snapshot.nativeSessionId }
          : {}),
        ...(snapshot.error !== undefined ? { errorCode: snapshot.error.code } : {}),
        ...(snapshot.droppedParts > 0 ? { droppedParts: snapshot.droppedParts } : {}),
        ...(snapshot.unhandledEvents.length > 0
          ? {
              unhandledEvents: snapshot.unhandledEvents.map((e) => ({
                type: e.type,
                count: e.count,
              })),
            }
          : {}),
        textChars: snapshot.textChars,
        chunks: snapshot.chunks,
      },
    },
  };
}

export function createChatModelAdapter(options: ChatModelAdapterOptions): AuiChatModelAdapter {
  const { transport } = options;
  // Identity by default: `textOfMessage` has already been applied to the last
  // message below, so the hook is a transform on the extracted text, not a
  // second extraction.
  const buildPrompt = options.prompt ?? ((text: string): string => text);

  return {
    async *run(runOptions): AsyncGenerator<AuiChatModelRunResult, void, undefined> {
      const messages = runOptions.messages;
      const last = messages[messages.length - 1];
      const prompt = last === undefined ? "" : buildPrompt(textOfMessage(last));
      if (prompt.length === 0) {
        throw new RuntimeError("createChatModelAdapter(): no user prompt to send", {});
      }

      const signal = runOptions.abortSignal;
      // Created without a `runId` filter: the first turn has no id yet, and
      // events without a `runId` are always accepted (old wire payloads).
      const turn: AssistantTurn = createAssistantTurn();
      let activeRunId: string | undefined;
      let cancelRequested = false;
      // Read through a closure: `cancelRequested` is only ever flipped from an
      // event listener, which control-flow analysis cannot see — reading the
      // variable directly would be narrowed to `false` and look dead.
      const isCancelling = (): boolean => cancelRequested;

      // The composer's Stop button aborts the fetch; ask the backend to stop
      // the live turn too, then let the stream drain to its terminal `done`.
      const onAbort = (): void => {
        cancelRequested = true;
        turn.markCancelled();
        void transport.cancel(activeRunId).catch(() => {
          // The abort already tore down our side; a failed cancel POST is the
          // backend's problem to log, not something to surface over the
          // user's Stop click.
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const started = await transport.startTurn(prompt, { signal });

        for await (const event of started.events) {
          if (event.runId !== undefined) activeRunId = event.runId;
          turn.apply(event);
          if (isCancelling()) turn.markCancelled();
          yield toRunResult(turn.snapshot());
          if (event.type === "done") break;
        }
        // A stream cut before `done` (network drop, unmount) must not leave a
        // message stuck on `running`.
        if (isCancelling()) turn.markCancelled();
        yield toRunResult(turn.snapshot());
      } catch (err) {
        if (signal.aborted) {
          turn.markCancelled();
          yield toRunResult(turn.snapshot());
          return;
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
