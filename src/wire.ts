import type { CreateSessionOptions } from "./core/runtime.js";
import type { RuntimeEvent } from "./events/runtime-event.js";
import { RuntimeProtocolError } from "./core/errors.js";

/**
 * Frontend wire contract (see `docs/frontend.md`).
 *
 * Everything that crosses a process boundary (SSE, WebSocket, Electron IPC)
 * must be plain JSON. `RuntimeEvent` already is (all payload fields are
 * `JsonValue`); this module pins down the two remaining pieces:
 *
 * - `WireCreateSessionOptions`: `CreateSessionOptions` minus
 *   `onPermissionRequest` and `logger`, which are functions and can never
 *   cross the wire.
 *   The permission flow stays in-process: the backend holds the handler and
 *   forwards `permission_request` events / `respondToPermission` answers.
 *   The logger stays in-process for the same reason: the backend holds the
 *   sink and only JSON crosses.
 * - NDJSON framing: one event per line (`encode`/`decode`), so consumers
 *   split on `\n` instead of reassembling partial JSON.
 */

export type WireCreateSessionOptions = Omit<CreateSessionOptions, "onPermissionRequest" | "logger">;

/**
 * Mid-run steering across the wire (BFF → agent backend). The frontend
 * sends `{ runId, text }` upstream (SSE POST / WebSocket message / IPC);
 * the backend routes it to the live run's `send()`. Text-only: prompt
 * images are not JSON-safe (`Uint8Array` payloads) and stay backend-side.
 * Unknown `runId`s and runs without `allowMidRunInput` reject loudly —
 * never silently dropped.
 */
export interface WireSendInput {
  runId: string;
  text: string;
}

/**
 * Answer to a pending `permission_request` event (frontend → agent backend).
 *
 * The interactive flow is backend-side: the backend holds
 * `onPermissionRequest` (parking the agent on a promise it later resolves),
 * forwards `permission_request` downstream for display, and routes this back
 * to `run.respondToPermission(id, optionId)`. `optionId` is one of the
 * `options[].optionId` the event offered — never a client-invented id.
 *
 * **Where `id` comes from, and its one hard limit.** `id` MUST be the
 * `permission_request.id` the UI was shown, and the backend MUST be able to
 * resolve it — that only works when `PermissionRequest.id` is present, which
 * today means claude (`AskUserQuestion` → the tool_use_id). ACP's
 * `session/request_permission` carries no request id and `AcpRun` does not
 * implement `respondToPermission`, so an ACP approval has to be answered
 * inside the handler: there is no UI round trip to carry an id. A backend that
 * cannot correlate must reject the answer loudly rather than invent a key —
 * an invented key never matches the id the UI holds.
 *
 * `permission_denied` needs no answer: the gate was already decided, and it
 * is observe-only.
 */
export interface WireRespondPermission {
  /** The `permission_request.id` being answered. */
  id: string;
  /** The chosen `options[].optionId`. */
  optionId: string;
}

const EVENT_TYPES = new Set([
  "session_started",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "usage",
  "permission_request",
  "permission_denied",
  "error",
  "done",
]);

/**
 * Structural guard for untrusted input: plain object with a known event
 * discriminant. Field payloads are JSON by construction (decoded from text),
 * so only the envelope shape is checked here.
 */
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as Record<string, unknown>)["type"];
  return typeof type === "string" && EVENT_TYPES.has(type);
}

/** Serialize one event to a single NDJSON line (trailing `\n` included). */
export function encodeRuntimeEvent(event: RuntimeEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parse one NDJSON line back to an event. Throws `RuntimeProtocolError`
 * (never leaks the raw line beyond 200 chars) on malformed JSON or an
 * unknown discriminant.
 */
export function decodeRuntimeEventLine(line: string): RuntimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (err) {
    throw new RuntimeProtocolError(
      `malformed event line: ${line.slice(0, 200)}`,
      {},
      { cause: err as Error },
    );
  }
  if (!isRuntimeEvent(parsed)) {
    throw new RuntimeProtocolError(`unknown event type in line: ${line.slice(0, 200)}`, {});
  }
  return parsed;
}
