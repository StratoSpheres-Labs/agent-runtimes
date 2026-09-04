/**
 * Identity of a runtime — how the registry knows who it is.
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md Task 1.1
 */
export interface RuntimeIdentity {
  /** Stable registry key, e.g. "opencode", "claude", "codex" */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Optional short description */
  description?: string;
}
