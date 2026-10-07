/**
 * The fold: `RuntimeEvent` → assistant-ui message parts + message status.
 *
 * One pure, framework-free reducer. Everything else in this folder (the BFF
 * transport, the two runtime adapters, the thread store) is a thin shell
 * around it, which is why it lives here and not in a runtime adapter: it is
 * agent-agnostic (Rule 6) and knows nothing about processes (Rule 4).
 *
 * Three assistant-ui invariants this file exists to satisfy (all verified
 * against `@assistant-ui/core@0.3.22` and its runtime docs):
 *
 * 1. **Snapshots, not deltas.** `useLocalRuntime` replaces `content` on every
 *    yield, so `snapshot()` always returns the FULL cumulative part list.
 * 2. **Only the last part may be `running`.** An empty trailing text part is
 *    destructive (it marks the previous part complete), so we never create a
 *    text/reasoning part without content.
 * 3. **Status is derived, never assigned.** `currentStatus()` recomputes from
 *    (error, cancelled, pending approvals, done) so the reducer cannot drift
 *    out of sync with what it has already folded.
 */

import type { JsonValue, RuntimeEvent } from "../../events/runtime-event.js";
import type {
  AuiApprovalResolution,
  AuiExternalPart,
  AuiJsonObject,
  AuiMessageStatus,
  AuiMessageTiming,
  AuiToolApproval,
  AuiToolApprovalOption,
  AuiToolCallPart,
  AuiTurnSnapshot,
  AuiUnhandledEvent,
  AuiUsage,
} from "./types.js";

/** Tool name used when a `tool_finished`/`permission_*` arrives for a call we never saw start. */
const UNKNOWN_TOOL_NAME = "unknown";

/**
 * Hard cap on retained parts.
 *
 * A pathological turn (an agent looping on a tool) would otherwise grow the
 * array without limit in the browser, and every part carries `argsText` plus a
 * possibly large `result`. The library caps its own event queue at 10k; this
 * is the client-side counterpart, lower because each part is heavier than an
 * event.
 *
 * Overflow evicts from the FRONT — the oldest, least interesting content — and
 * never evicts a tool call still waiting on an approval (dropping that would
 * silently discard a gate the user is looking at). `droppedParts` records how
 * much was lost so the UI can say so instead of quietly lying.
 */
export const MAX_TURN_PARTS = 2000;

/**
 * Distinct unknown event types kept for reporting. Small on purpose: this is a
 * diagnostic, not a log — a host that wants more tail them itself.
 */
const MAX_UNHANDLED_TYPES = 8;

/** assistant-ui's closed `ToolApprovalOptionKind` set, with ACP's underscore spellings normalized. */
const APPROVAL_KINDS: Record<string, string> = {
  allow_once: "allow-once",
  allow_always: "allow-always",
  reject_once: "reject-once",
  reject_always: "reject-always",
};

export interface AssistantTurnOptions {
  /**
   * Only fold events carrying this `runId`. Events WITHOUT a `runId` are
   * always accepted (old wire payloads), so an unstamped stream still works.
   */
  readonly runId?: string;
  /** Clock for timing metrics. Injectable so tests are deterministic. */
  readonly now?: () => number;
}

export interface AssistantTurn {
  /** Fold one event. Unknown discriminants are ignored (fail open — see `docs/frontend.md` §Versioning). */
  apply(event: RuntimeEvent): void;
  /**
   * Append a structured `data-*` part (the open extension channel) or upsert
   * a tool call by `toolCallId`. Throws on an empty text/reasoning part:
   * callers are application code, and invariant 2 makes silence wrong here.
   */
  emit(part: AuiExternalPart): void;
  /** Settle a pending approval (the Allow / Deny click) and drop it from the gate. */
  resolveApproval(id: string, resolution: AuiApprovalResolution): boolean;
  /**
   * Re-open a settled gate — the rollback path when the answer could not be
   * delivered upstream. Without it a failed POST would leave the card reading
   * "allowed" while the agent is still parked.
   */
  reopenApproval(id: string): boolean;
  /** Mark the turn cancelled — `snapshot().status` becomes `incomplete/cancelled` unless an error outranks it. */
  markCancelled(): void;
  snapshot(): AuiTurnSnapshot;
}

/**
 * `tool_started.input` is a `JsonValue` (string, array, or scalar), while
 * assistant-ui types `args` as a JSON object. Objects pass through; anything
 * else is wrapped under a stable `value` key so no data is lost, with the raw
 * JSON always available as `argsText`.
 */
function toToolArgs(input: JsonValue | undefined): { args: AuiJsonObject; argsText: string } {
  if (input === undefined) return { args: {}, argsText: "{}" };
  const argsText = JSON.stringify(input);
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return { args: input, argsText };
  }
  return { args: { value: input }, argsText };
}

function normalizeApprovalKind(kind: string): string {
  return APPROVAL_KINDS[kind] ?? kind.replaceAll("_", "-");
}

function toApprovalOptions(
  options: readonly { optionId: string; kind: string; label?: string }[],
): readonly AuiToolApprovalOption[] | undefined {
  // Omitting `options` entirely is what makes assistant-ui render its plain
  // Allow / Deny pair — an empty list would render nothing clickable.
  if (options.length === 0) return undefined;
  return options.map((o) => {
    const mapped: AuiToolApprovalOption = {
      id: o.optionId,
      kind: normalizeApprovalKind(o.kind),
      ...(o.label !== undefined ? { label: o.label } : {}),
    };
    return mapped;
  });
}

/** Mutable twin of `AuiToolCallPart` — the fold patches these in place, then projects. */
interface MutableToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: AuiJsonObject;
  argsText: string;
  result?: JsonValue;
  isError?: boolean;
  approval?: AuiToolApproval;
}

function projectToolCall(call: MutableToolCall): AuiToolCallPart {
  return {
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.args,
    argsText: call.argsText,
    ...(call.result !== undefined ? { result: call.result } : {}),
    ...(call.isError !== undefined ? { isError: call.isError } : {}),
    ...(call.approval !== undefined ? { approval: call.approval } : {}),
  };
}

export function createAssistantTurn(options?: AssistantTurnOptions): AssistantTurn {
  const runId = options?.runId;
  const now = options?.now ?? ((): number => Date.now());
  /** Ordered so the UI keeps interleaving: reasoning → tool → text stays visible. */
  const parts: AuiExternalPart[] = [];
  const toolCalls = new Map<string, MutableToolCall>();
  const unhandled = new Map<string, AuiUnhandledEvent>();
  let nativeSessionId: string | undefined;
  let usage: AuiUsage | undefined;
  let lastError: { code: string; message: string } | undefined;
  let cancelled = false;
  let done = false;
  let textChars = 0;
  let chunks = 0;
  let droppedParts = 0;
  let startedAt: number | undefined;
  let firstTokenAt: number | undefined;
  /** Frozen when the turn settles — timing must not keep moving afterwards. */
  let settledAt: number | undefined;

  /**
   * Record an event we cannot project. Never stores the payload: it is
   * untrusted wire data, unbounded in size, and could echo a prompt fragment.
   * The type NAME is what a host needs to know it is out of date.
   */
  function recordUnhandled(event: RuntimeEvent): void {
    // Every known discriminant is handled above, so `event` narrows to
    // `never` here — read the name off the value instead.
    const type = (event as { type?: unknown }).type;
    const name = typeof type === "string" ? type : "unknown";
    const at = now();
    const existing = unhandled.get(name);
    if (existing !== undefined) {
      unhandled.set(name, { ...existing, count: existing.count + 1, lastSeenAt: at });
      return;
    }
    // Past the cap, keep counting into a single overflow bucket rather than
    // growing without bound.
    if (unhandled.size >= MAX_UNHANDLED_TYPES) {
      const overflow = unhandled.get("…");
      unhandled.set("…", {
        type: "…",
        count: (overflow?.count ?? 0) + 1,
        firstSeenAt: overflow?.firstSeenAt ?? at,
        lastSeenAt: at,
      });
      return;
    }
    unhandled.set(name, { type: name, count: 1, firstSeenAt: at, lastSeenAt: at });
  }

  function timing(): AuiMessageTiming {
    // Before anything folded there is no start to measure from; callers see
    // `ready` before this is ever read.
    const start = startedAt ?? now();
    const ended = settledAt;
    const totalStreamTime = ended === undefined ? undefined : Math.max(0, ended - start);
    const tokenCount = usage?.outputTokens;
    const seconds = totalStreamTime === undefined ? undefined : totalStreamTime / 1000;
    return {
      streamStartTime: start,
      ...(firstTokenAt !== undefined ? { firstTokenTime: firstTokenAt - start } : {}),
      ...(totalStreamTime !== undefined ? { totalStreamTime } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}),
      ...(tokenCount !== undefined && seconds !== undefined && seconds > 0
        ? { tokensPerSecond: tokenCount / seconds }
        : {}),
      totalChunks: chunks,
      toolCallCount: toolCalls.size,
    };
  }

  function upsertToolCall(id: string, toolName: string | undefined): MutableToolCall {
    const existing = toolCalls.get(id);
    if (existing !== undefined) {
      if (toolName !== undefined && toolName !== UNKNOWN_TOOL_NAME) existing.toolName = toolName;
      return existing;
    }
    const created: MutableToolCall = {
      type: "tool-call",
      toolCallId: id,
      toolName: toolName ?? UNKNOWN_TOOL_NAME,
      args: {},
      argsText: "{}",
    };
    toolCalls.set(id, created);
    parts.push(created);
    // Bound the part array here too, but a brand-new call is not gated yet —
    // `permission_request` may arrive on the very next event, and evicting it
    // immediately would lose the gate. `enforceCap` skips gated parts, so the
    // call is re-checked once its gate opens.
    if (parts.length > MAX_TURN_PARTS) enforceCap();
    return created;
  }

  /** A tool call whose approval gate is still open — never evict these. */
  function isGated(part: AuiExternalPart): boolean {
    return (
      part.type === "tool-call" &&
      part.approval !== undefined &&
      part.approval.approved === undefined
    );
  }

  /**
   * Enforce `MAX_TURN_PARTS` by dropping from the front. Skips gated tool
   * calls (evicting one would silently discard a gate the user is looking at)
   * and counts what it lost.
   */
  function enforceCap(): void {
    while (parts.length > MAX_TURN_PARTS) {
      const victim = parts.findIndex((p) => !isGated(p));
      // Everything left is gated: dropping one would be worse than growing.
      if (victim === -1) return;
      parts.splice(victim, 1);
      droppedParts += 1;
    }
  }

  /** Append to the trailing text part, or open a new one. Never creates an empty part. */
  function appendText(text: string): void {
    if (text.length === 0) return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.type === "text") {
      parts[parts.length - 1] = { type: "text", text: last.text + text };
      return;
    }
    parts.push({ type: "text", text });
    enforceCap();
  }

  function appendReasoning(text: string): void {
    if (text.length === 0) return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.type === "reasoning") {
      parts[parts.length - 1] = { type: "reasoning", text: last.text + text };
      return;
    }
    parts.push({ type: "reasoning", text });
    enforceCap();
  }

  function currentStatus(): AuiMessageStatus {
    // Most specific wins: a turn that errored should not read as a clean
    // cancel, and a turn waiting on the user must not read as running.
    if (lastError !== undefined) {
      return {
        type: "incomplete",
        reason: "error",
        error: { code: lastError.code, message: lastError.message },
      };
    }
    if (cancelled) return { type: "incomplete", reason: "cancelled" };
    if (pendingApprovals() > 0) return { type: "requires-action", reason: "tool-calls" };
    if (done) return { type: "complete", reason: "stop" };
    return { type: "running" };
  }

  function pendingApprovals(): number {
    let count = 0;
    for (const call of toolCalls.values()) {
      if (call.approval !== undefined && call.approval.approved === undefined) count += 1;
    }
    return count;
  }

  function shouldApply(event: RuntimeEvent): boolean {
    if (runId === undefined || event.runId === undefined) return true;
    return event.runId === runId;
  }

  return {
    apply(event: RuntimeEvent): void {
      if (!shouldApply(event)) return;
      chunks += 1;
      if (startedAt === undefined) startedAt = now();
      switch (event.type) {
        case "session_started": {
          nativeSessionId = event.sessionId;
          return;
        }
        case "text_delta": {
          textChars += event.text.length;
          if (firstTokenAt === undefined) firstTokenAt = now();
          appendText(event.text);
          return;
        }
        case "reasoning_delta": {
          appendReasoning(event.text);
          return;
        }
        case "tool_started": {
          const call = upsertToolCall(event.id, event.name);
          const { args, argsText } = toToolArgs(event.input);
          call.args = args;
          call.argsText = argsText;
          return;
        }
        case "tool_finished": {
          const call = upsertToolCall(event.id, undefined);
          if (event.output !== undefined) call.result = event.output;
          if (event.error !== undefined) call.isError = event.error;
          // The gate, if any, is settled by the fact that the call ran.
          if (call.approval !== undefined && call.approval.approved === undefined) {
            call.approval = { ...call.approval, approved: true };
          }
          return;
        }
        case "permission_request": {
          const call = upsertToolCall(event.id, event.toolName);
          call.approval = {
            id: event.id,
            ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
            ...(toApprovalOptions(event.options) !== undefined
              ? { options: toApprovalOptions(event.options) }
              : {}),
          };
          return;
        }
        case "permission_denied": {
          const call = upsertToolCall(event.id, event.toolName);
          const reason = event.reason ?? "permission denied";
          call.approval = {
            id: event.id,
            ...(call.approval?.prompt !== undefined ? { prompt: call.approval.prompt } : {}),
            ...(call.approval?.options !== undefined ? { options: call.approval.options } : {}),
            approved: false,
            reason,
          };
          // Deny synthesizes an error result so the card reads "blocked", not "silent".
          call.result = {
            error: reason,
            ...(event.kind !== undefined ? { kind: event.kind } : {}),
          };
          call.isError = true;
          return;
        }
        case "usage": {
          // Last-wins per field: a turn's final `usage` event is its tally.
          usage = {
            ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            ...(event.cacheTokens !== undefined ? { cacheTokens: event.cacheTokens } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
          };
          return;
        }
        case "error": {
          lastError = { code: event.error.code, message: event.error.message };
          return;
        }
        case "done": {
          done = true;
          // Freeze the clock here: totalStreamTime must not keep growing
          // after the turn ended, or every consumer reading it later sees a
          // different number.
          if (settledAt === undefined) settledAt = now();
          return;
        }
        // Unknown discriminants are ignored — the event set only grows, and
        // consumers must fail open rather than throw — but they are RECORDED,
        // so a host can tell "nothing happened" from "we dropped something we
        // do not understand yet".
        default:
          recordUnhandled(event);
          return;
      }
    },

    emit(part: AuiExternalPart): void {
      if (part.type === "text" && part.text.length === 0) {
        throw new TypeError("emit(): an empty text part would mark the previous part complete");
      }
      if (part.type === "reasoning" && part.text.length === 0) {
        throw new TypeError(
          "emit(): an empty reasoning part would mark the previous part complete",
        );
      }
      if (part.type === "tool-call") {
        const call = upsertToolCall(part.toolCallId, part.toolName);
        Object.assign(call, part);
        return;
      }
      parts.push(part);
      enforceCap();
    },

    resolveApproval(id: string, resolution: AuiApprovalResolution): boolean {
      const call = toolCalls.get(id);
      if (call === undefined || call.approval === undefined) return false;
      call.approval = {
        ...call.approval,
        approved: resolution.approved,
        ...(resolution.optionId !== undefined ? { optionId: resolution.optionId } : {}),
        ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
      };
      if (!resolution.approved) {
        const reason = resolution.reason ?? "denied";
        call.result = { error: reason };
        call.isError = true;
      }
      return true;
    },

    reopenApproval(id: string): boolean {
      const call = toolCalls.get(id);
      if (call === undefined || call.approval === undefined) return false;
      // Keep `id` / `prompt` / `options` — those describe the QUESTION, which
      // is still being asked. Drop only the decision fields, so the gate is
      // pending again and the status returns to `requires-action`.
      const {
        approved: _approved,
        optionId: _optionId,
        reason: _reason,
        ...question
      } = call.approval;
      call.approval = question;
      // A denial synthesized an error result; reopening is not a denial.
      if (call.isError === true) {
        delete call.result;
        delete call.isError;
      }
      return true;
    },

    markCancelled(): void {
      cancelled = true;
    },

    snapshot(): AuiTurnSnapshot {
      return {
        parts: parts.map((p) =>
          p.type === "tool-call" ? projectToolCall(p as MutableToolCall) : p,
        ),
        status: currentStatus(),
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(lastError !== undefined ? { error: lastError } : {}),
        cancelled,
        textChars,
        chunks,
        droppedParts,
        unhandledEvents: [...unhandled.values()],
        timing: timing(),
      };
    },
  };
}
