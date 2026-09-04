/**
 * Agent-agnostic permission delegation — Phase 24.
 * Only ACP transports `agent → client` requests (`session/request_permission`,
 * `fs/read_text_file`, etc.). CLI runtimes (claude/codex/opencode run) use
 * flag gating (`--permission-mode`, `--sandbox`) via WorkspaceOptions; this
 * handler is for interactive ACP turns that would otherwise stall or get a
 * blanket `-32601` denial.
 * Never leaks secrets — `options` carry only optionIds/kinds/labels.
 */
export interface PermissionOption {
  optionId: string;
  kind: string;
  label?: string;
}

export interface PermissionRequest {
  /** JSON-RPC method, e.g. "session/request_permission" */
  method: string;
  sessionId?: string;
  toolName?: string;
  path?: string;
  /** Choices the agent offers — at least one. */
  options: PermissionOption[];
  /** Raw params for future-proofing (never secrets). */
  raw: unknown;
}

export interface PermissionResponse {
  optionId: string;
}

export type PermissionHandler = (
  req: PermissionRequest,
) => Promise<PermissionResponse> | PermissionResponse;
