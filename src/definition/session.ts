/**
 * Session behavior for v0.1 — presence-only, details deferred to Phase 4/15.
 * Kept here so src/definition layout matches the intended structure
 * (Dev_Docs/agent_runtimes_dev_plan.md:392).
 */
export interface SessionDefinition {
  /** Whether this runtime supports persistent sessions */
  persistent: boolean;
}
