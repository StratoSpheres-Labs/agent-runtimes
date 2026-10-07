/**
 * assistant-ui message shapes — a local, dependency-free mirror of the
 * structural types `@assistant-ui/core` accepts.
 *
 * Why local types instead of `import type { ThreadMessageLike } from
 * "@assistant-ui/core"`: the browser bundle must stay dependency-free (Rule 0
 * of `docs/frontend.md` — no `node:` specifiers, no runtime deps), and a
 * type-only import of a peer would still force every consumer to install
 * it. Drift is caught at compile time instead by
 * `tests/assistant-ui-conformance.test.ts`, which assigns these types to the
 * real upstream ones — if upstream moves a field, that test fails.
 *
 * Field-by-field provenance (verified against `@assistant-ui/core@0.3.22`):
 * - `TextMessagePart` / `ReasoningMessagePart`: `{ type, text }`
 * - `ToolCallMessagePart`: `{ type, toolCallId, toolName, args, argsText,
 *   result?, isError?, approval? }` — `argsText` is REQUIRED upstream, so we
 *   always emit it (raw JSON text of the tool input).
 * - `MessageStatus`: `{ type: running | requires-action | complete |
 *   incomplete }`, with `requires-action` carrying a `reason` and
 *   `incomplete` an optional `error`.
 *
 * ## Why there are TWO part unions
 *
 * assistant-ui splits its data-part channel across two different unions:
 * `ThreadMessageLikePart` (the external-store path) accepts the prefixed
 * `{ type: "data-<name>", data }` form, while `ThreadAssistantMessagePart`
 * (what `ChatModelRunResult.content` is typed against, i.e. the local-runtime
 * path) accepts only `{ type: "data", name, data }`. A single union cannot
 * satisfy both, so:
 *
 * - {@link AuiPart} — safe in BOTH runtimes; what the fold and the chat-model
 *   adapter use.
 * - {@link AuiExternalPart} — `AuiPart` plus the prefixed form; what
 *   `useExternalStoreRuntime` accepts.
 */

import type { JsonValue } from "../../events/runtime-event.js";

/**
 * Recursive READONLY JSON. Upstream models this as `ReadonlyJSONValue`; the
 * readonly index signature matters — a mutable `{ [k: string]: JsonValue }` is
 * not assignable to upstream's readonly form, so `status.error` and tool
 * `args` need this shape rather than the library's own `JsonValue`.
 */
export type AuiJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AuiJsonValue[]
  | { readonly [key: string]: AuiJsonValue };

/** Recursive readonly JSON object — the shape assistant-ui wants for `args`. */
export type AuiJsonObject = { readonly [key: string]: AuiJsonValue };

/**
 * assistant-ui `MessageStatus`. Note the British spelling `cancelled`
 * (upstream uses it too) and that `requires-action` carries a `reason`.
 */
export type AuiMessageStatus =
  | { readonly type: "running" }
  | { readonly type: "requires-action"; readonly reason: "tool-calls" | "interrupt" }
  | { readonly type: "complete"; readonly reason: "stop" | "unknown" }
  | {
      readonly type: "incomplete";
      readonly reason: "cancelled" | "tool-calls" | "length" | "content-filter" | "other" | "error";
      readonly error?: AuiJsonValue;
    };

export interface AuiTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface AuiReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
}

/**
 * One decision offered by a `permission_request`. assistant-ui treats `kind`
 * as an open union (`"allow-once" | "allow-always" | "reject-once" |
 * "reject-always"` plus any string), so we forward the CLI's own `kind`
 * after normalizing the underscore spellings ACP uses.
 */
export interface AuiToolApprovalOption {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
}

/**
 * Server-side approval gate. Emitted pending (no `approved`) while the turn
 * waits; settled (`approved` + `optionId`/`reason`) once answered.
 */
export interface AuiToolApproval {
  readonly id: string;
  readonly prompt?: string;
  readonly options?: readonly AuiToolApprovalOption[];
  readonly approved?: boolean;
  readonly optionId?: string;
  readonly reason?: string;
}

export interface AuiToolCallPart {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: AuiJsonObject;
  readonly argsText: string;
  readonly result?: JsonValue;
  readonly isError?: boolean;
  readonly approval?: AuiToolApproval;
}

/**
 * The `data-<name>` extension channel, as `ThreadMessageLike` spells it.
 * External-store only — see {@link AuiPart}.
 */
export interface AuiDataPart {
  readonly type: `data-${string}`;
  readonly data: JsonValue;
}

/**
 * The same channel as `ThreadAssistantMessagePart` spells it: bare `"data"`
 * discriminant with the suffix in `name`. This is the form the local-runtime
 * (`ChatModelRunResult`) path requires.
 */
export interface AuiNamedDataPart {
  readonly type: "data";
  readonly name: string;
  readonly data: JsonValue;
}

/**
 * Parts valid in BOTH runtimes. What the fold emits and what
 * `ChatModelRunResult.content` carries.
 */
export type AuiPart = AuiTextPart | AuiReasoningPart | AuiToolCallPart | AuiNamedDataPart;

/**
 * Parts valid on the external-store path: {@link AuiPart} plus the prefixed
 * `data-<name>` form, which the external-store converter promotes to a
 * `DataMessagePart` automatically.
 */
export type AuiExternalPart = AuiPart | AuiDataPart;

/** Token/cost accounting folded out of the `RuntimeEvent`s `usage` event. */
export interface AuiUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheTokens?: number;
  readonly costUsd?: number;
  readonly model?: string;
}

/**
 * Per-message streaming metrics — the shape assistant-ui's `MessageTiming`
 * consumers (tokens/s, time-to-first-token, totals) already read.
 *
 * The fold has had the raw counts all along (`chunks`, `textChars`, the
 * `usage` token tally); this is that data actually published instead of
 * recomputed by every consumer.
 */
export interface AuiMessageTiming {
  /** Epoch ms of the first event folded into this turn. */
  readonly streamStartTime: number;
  /**
   * Time to first token, in ms — a DURATION from `streamStartTime`, not an
   * epoch (matching `totalStreamTime`, and `tokensPerSecond` divides by it).
   */
  readonly firstTokenTime?: number;
  /** DURATION in ms, from `streamStartTime`. Present only once the turn settled. */
  readonly totalStreamTime?: number;
  /** Output tokens, when a `usage` event reported them. */
  readonly tokenCount?: number;
  /** `tokenCount` ÷ seconds, when both are known. */
  readonly tokensPerSecond?: number;
  readonly totalChunks: number;
  readonly toolCallCount: number;
}

/** Shared `metadata` shape for `ThreadMessageLike` and `ChatModelRunResult`. */
export interface AuiMessageMetadata {
  readonly steps?: readonly {
    readonly messageId?: string;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }[];
  readonly timing?: AuiMessageTiming;
  readonly custom?: Record<string, unknown>;
}

/**
 * One event type this adapter could not project, with a running count.
 *
 * The event set only grows, so an unknown discriminant must never throw — but
 * dropping it *silently* means a CLI upgrade quietly loses content with no way
 * to notice. Recording the type name (never the payload: it is untrusted data
 * and unbounded) turns that into something a host can surface or log.
 */
export interface AuiUnhandledEvent {
  readonly type: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/**
 * Whether the thread has content yet — and if not, WHY.
 *
 * Without this an empty thread is ambiguous: no messages sent yet, a first
 * turn in flight, or the backend unreachable all render identically.
 */
export type AuiLoadState =
  | { readonly type: "idle" }
  | { readonly type: "loading" }
  | { readonly type: "ready" }
  | { readonly type: "error"; readonly error: unknown };

/**
 * Run lifecycle. `cancelling` is separate from `streaming` because after the
 * user presses Stop the agent keeps producing events until the terminal `done`
 * — reporting "generating" throughout that window is wrong.
 */
export type AuiRunState =
  | { readonly type: "idle" }
  | { readonly type: "streaming" }
  | { readonly type: "cancelling" }
  | { readonly type: "error"; readonly error: unknown };

/**
 * A `ThreadMessageLike` we can hand to `useExternalStoreRuntime` verbatim
 * (`convertMessage: (m) => m`). A structural subset: role, content, id,
 * createdAt, status, metadata.
 *
 * Outbound-only. Everything WE emit fits here and is assignable to
 * assistant-ui's `ThreadMessageLike`. The reverse direction is not — see
 * {@link AuiInboundMessage}.
 */
export interface AuiThreadMessageLike {
  readonly role: "assistant" | "user" | "system";
  readonly content: string | readonly AuiExternalPart[];
  readonly id?: string;
  readonly createdAt?: Date;
  readonly status?: AuiMessageStatus;
  readonly metadata?: AuiMessageMetadata;
}

/**
 * What `setMessages` (branch switching) may hand us: a message assistant-ui
 * produced itself, whose content can hold parts this package never emits
 * (image, file, audio, source, generative-ui, mcp…).
 *
 * The permissive `unknown[]` content is deliberate and load-bearing — it is
 * what makes assistant-ui's `ThreadMessageLike` assignable to this type, which
 * is the direction a callback parameter needs. We never introspect inbound
 * parts: they are stored and re-broadcast untouched.
 */
export interface AuiInboundMessage {
  readonly role: "assistant" | "user" | "system";
  readonly content: string | readonly unknown[];
  readonly id?: string;
  readonly createdAt?: Date;
  readonly status?: AuiMessageStatus;
}

/**
 * `ChatModelRunResult` — what `useLocalRuntime`'s `ChatModelAdapter` yields.
 * `content` is the FULL cumulative snapshot (never a delta) and `metadata`
 * carries the fold's non-visual facts.
 */
export interface AuiChatModelRunResult {
  readonly content?: readonly AuiPart[];
  readonly status?: AuiMessageStatus;
  readonly metadata?: AuiMessageMetadata;
}

/**
 * The user's answer to a pending approval gate. Mirrors assistant-ui's
 * `RespondToToolApprovalOptions` so `onRespondToToolApproval` can forward it
 * verbatim; `optionId` is the CLI's own choice id (`WireRespondPermission`).
 */
export interface AuiApprovalResolution {
  readonly approved: boolean;
  readonly optionId?: string;
  readonly reason?: string;
}

/**
 * Snapshot of one assistant turn — the fold's observable output.
 */
export interface AuiTurnSnapshot {
  /**
   * Cumulative parts, in emission order. Never contains an empty
   * text/reasoning part — only the last part may report `running`.
   */
  readonly parts: readonly AuiExternalPart[];
  readonly status: AuiMessageStatus;
  /** Native agent session id from `session_started` (resume handle). */
  readonly nativeSessionId?: string;
  readonly usage?: AuiUsage;
  /** Last `error` event seen this turn (`code` is the machine surface). */
  readonly error?: { readonly code: string; readonly message: string };
  /** True once `markCancelled()` ran — `done` then settles as `cancelled`. */
  readonly cancelled: boolean;
  /** How many `text_delta` characters arrived — feeds `MessageTiming`. */
  readonly textChars: number;
  /** How many events were folded in (chunk count for `MessageTiming`). */
  readonly chunks: number;
  /**
   * Parts evicted by the `MAX_TURN_PARTS` cap. Non-zero means the transcript
   * shown is incomplete — surface it rather than presenting a truncated turn
   * as whole.
   */
  readonly droppedParts: number;
  /** Event types this adapter could not project (see {@link AuiUnhandledEvent}). */
  readonly unhandledEvents: readonly AuiUnhandledEvent[];
  /** Streaming metrics, ready to hand to assistant-ui's `MessageTiming` consumers. */
  readonly timing: AuiMessageTiming;
}
