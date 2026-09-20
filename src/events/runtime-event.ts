/**
 * Unified RuntimeEvent — agent-agnostic (Rule 6).
 * Tasks 6.1-6.4 + Dev_Docs:875-943
 * Consumers must never see stdout/stderr/JSONL.
 */

/**
 * JSON-serializable value. Every event payload field uses this (never
 * `unknown`) so a `RuntimeEvent` always survives `JSON.stringify` for SSE /
 * IPC transport: no functions, class instances, `undefined`, or BigInts can
 * hide in `input`/`output`/`cause`/`raw`. Producers bridge JSON.parse output
 * via `asJsonValue` (JSON by construction, documented there).
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Trust a JSON.parse-derived value as JsonValue (`undefined` stays absent).
 * Call only with data decoded from JSON text — never with foreign values
 * (class instances, functions), which must be serialized first.
 */
export function asJsonValue(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : (value as JsonValue);
}

/**
 * Run attribution (Phase 34). Every event a Run emits carries the Run's id
 * (`<sessionId>:run<N>`), so consumers can group interleaved events from
 * concurrent sessions/runs. Optional for wire compatibility (old decoders
 * ignore it); parsers never set it (Rule 4 — stamping is the Run's job).
 */
export interface RunScoped {
  runId?: string;
}

export interface SessionStartedEvent extends RunScoped {
  type: "session_started";
  sessionId: string;
}

export interface TextDeltaEvent extends RunScoped {
  type: "text_delta";
  text: string;
}

/**
 * A chunk of the agent's thinking/reasoning (never the final answer).
 * Surfaces what parsers used to drop (claude thinking blocks, ACP
 * thought chunks, empty-text opencode reasoning) or misfile as tools
 * (codex reasoning items). Consumers render it dimmed/collapsed or ignore
 * it — it is display-only and never resumable input.
 */
export interface ReasoningDeltaEvent extends RunScoped {
  type: "reasoning_delta";
  text: string;
}

export interface ToolStartedEvent extends RunScoped {
  type: "tool_started";
  id: string;
  name: string;
  input?: JsonValue;
}

export interface ToolFinishedEvent extends RunScoped {
  type: "tool_finished";
  id: string;
  output?: JsonValue;
  error?: boolean;
}

export interface ErrorEvent extends RunScoped {
  type: "error";
  error: {
    code: string;
    message: string;
    cause?: JsonValue;
  };
}

export interface DoneEvent extends RunScoped {
  type: "done";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface UsageEvent extends RunScoped {
  type: "usage";
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
  model?: string;
  raw?: JsonValue;
}

export interface PermissionRequestEvent extends RunScoped {
  type: "permission_request";
  id: string;
  toolName?: string;
  prompt?: string;
  options: Array<{ optionId: string; kind: string; label?: string }>;
  raw?: JsonValue;
}

export type RuntimeEvent =
  | SessionStartedEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | ErrorEvent
  | DoneEvent
  | UsageEvent
  | PermissionRequestEvent;
