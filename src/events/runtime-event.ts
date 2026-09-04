/**
 * Unified RuntimeEvent — agent-agnostic (Rule 6).
 * Tasks 6.1-6.4 + Dev_Docs:875-943
 * Consumers must never see stdout/stderr/JSONL.
 */

export interface SessionStartedEvent {
  type: "session_started";
  sessionId: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ToolStartedEvent {
  type: "tool_started";
  id: string;
  name: string;
  input?: unknown;
}

export interface ToolFinishedEvent {
  type: "tool_finished";
  id: string;
  output?: unknown;
  error?: boolean;
}

export interface ErrorEvent {
  type: "error";
  error: {
    code: string;
    message: string;
    cause?: unknown;
  };
}

export interface DoneEvent {
  type: "done";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface UsageEvent {
  type: "usage";
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
  model?: string;
  raw?: unknown;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  id: string;
  toolName?: string;
  prompt?: string;
  options: Array<{ optionId: string; kind: string; label?: string }>;
  raw?: unknown;
}

export type RuntimeEvent =
  | SessionStartedEvent
  | TextDeltaEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | ErrorEvent
  | DoneEvent
  | UsageEvent
  | PermissionRequestEvent;
