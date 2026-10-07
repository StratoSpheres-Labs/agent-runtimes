/**
 * `@stratosphereslab/agent-runtimes/assistant-ui` — the browser-safe entry
 * point.
 *
 * Import from HERE, never from the package root: `src/index.ts` pulls in
 * `node:module` and `node:child_process`, which no bundler can ship to a
 * renderer. This entry has zero runtime dependencies and zero `node:`
 * specifiers (`tests/assistant-ui-browser-safe.test.ts` walks the import graph
 * and fails the build if that ever changes).
 *
 * The whole surface is four layers, thinnest last:
 *
 * ```
 * RuntimeEvent ──fold──▶ AuiTurnSnapshot ──▶ ThreadMessageLike / ChatModelRunResult
 *      ▲                                                   │
 *      └── transport ──stream── SSE / NDJSON               ▼
 *                                            assistant-ui runtime hook
 * ```
 *
 * Pick the runtime hook by what your UI needs:
 *
 * | Hook | Use when | Entry |
 * | ---- | -------- | ----- |
 * | `useExternalStoreRuntime` | approvals, server interrupts, edit/regenerate — the usual choice for a coding agent | `createThreadStore` + `createExternalStoreAdapter` |
 * | `useLocalRuntime` | you want assistant-ui to own branching/edit/regenerate and the backend stays out of it | `createChatModelAdapter` |
 */

export type {
  AuiApprovalResolution,
  AuiChatModelRunResult,
  AuiDataPart,
  AuiExternalPart,
  AuiInboundMessage,
  AuiJsonObject,
  AuiJsonValue,
  AuiLoadState,
  AuiMessageMetadata,
  AuiMessageStatus,
  AuiMessageTiming,
  AuiNamedDataPart,
  AuiPart,
  AuiReasoningPart,
  AuiRunState,
  AuiTextPart,
  AuiThreadMessageLike,
  AuiToolApproval,
  AuiToolApprovalOption,
  AuiToolCallPart,
  AuiTurnSnapshot,
  AuiUnhandledEvent,
  AuiUsage,
} from "./types.js";
export {
  createAssistantTurn,
  MAX_TURN_PARTS,
  type AssistantTurn,
  type AssistantTurnOptions,
} from "./fold.js";
export {
  decodeNdjsonChunk,
  decodeSseChunk,
  readEventStream,
  readNdjsonEvents,
  readSseEvents,
  type ByteStreamLike,
} from "./stream.js";
export {
  createRuntimeTransport,
  type RuntimeTransport,
  type RuntimeTransportEndpoints,
  type RuntimeTransportOptions,
  type RuntimeTurn,
} from "./transport.js";
export {
  createChatModelAdapter,
  textOfMessage,
  type AuiChatModelAdapter,
  type ChatModelAdapterOptions,
} from "./chat-model.js";
export {
  createExternalStoreAdapter,
  createThreadStore,
  type AuiExternalStoreAdapter,
  type ThreadStore,
  type ThreadStoreOptions,
  type ThreadStoreSnapshot,
} from "./external-store.js";
