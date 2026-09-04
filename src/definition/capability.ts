/**
 * What a runtime can do — checked via capabilities, not `id === "xxx"`.
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md Task 1.5 + Phase 14
 */
export interface RuntimeCapabilities {
  /** Can stream incremental events (vs. batch output) */
  streaming: boolean;
  /** Can resume an existing session across processes */
  sessionResume: boolean;
  /** Can select / switch model via API */
  modelSelection: boolean;
  /** Supports reasoning / thinking effort controls */
  reasoning: boolean;
  /** Accepts image inputs */
  images: boolean;
  /** Exposes workspace allowlist / permission / sandbox gating */
  workspace: boolean;
}
