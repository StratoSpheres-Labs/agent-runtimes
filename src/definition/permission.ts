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
  /**
   * The request's own id — the SAME string as the `permission_request`
   * event's `id`, and the first argument of
   * `AgentRun.respondToPermission(id, optionId)`.
   *
   * This is what lets a backend that parks the agent (the usual shape: the
   * handler returns a promise the UI later resolves) correlate the answer it
   * receives from the browser with the request it is holding. Without it the
   * backend must invent its own key, and that key can never match the id the
   * UI was shown.
   *
   * Optional because not every transport has one: claude supplies the
   * `tool_use_id`, ACP's `session/request_permission` carries no request id
   * (and `AcpRun` does not implement `respondToPermission` — an ACP approval
   * must be answered inside the handler, there is no UI round trip).
   */
  id?: string;
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
