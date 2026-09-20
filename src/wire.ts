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
 *   `onPermissionRequest`, which is a function and can never cross the wire.
 *   The permission flow stays in-process: the backend holds the handler and
 *   forwards `permission_request` events / `respondToPermission` answers.
 * - NDJSON framing: one event per line (`encode`/`decode`), so consumers
 *   split on `\n` instead of reassembling partial JSON.
 */

export type WireCreateSessionOptions = Omit<CreateSessionOptions, "onPermissionRequest">;

const EVENT_TYPES = new Set([
  "session_started",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "usage",
  "permission_request",
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
