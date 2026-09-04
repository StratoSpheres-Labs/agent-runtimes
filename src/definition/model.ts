/**
 * Phase 16 — Model abstraction
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md:1366-1399
 * Keep it minimal: provider/model selection, not a global taxonomy.
 */

export interface RuntimeModel {
  id: string;
  name?: string;
  provider?: string;
}

export interface ModelDefinition {
  /** Static fallback list when live discovery fails */
  fallbackModels: RuntimeModel[];
  /** Command to list models live (e.g. `opencode models`) */
  listCommand?: string[];
}
