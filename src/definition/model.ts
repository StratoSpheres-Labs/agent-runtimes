/**
 * Phase 16 — Model abstraction
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md:1366-1399
 * Keep it minimal: provider/model selection, not a global taxonomy.
 */

export interface RuntimeModel {
  id: string;
  name?: string;
  provider?: string;
  /**
   * Per-model reasoning choices advertised live (e.g. opencode `models
   * --verbose` `variants` keys). Absent = unknown (plain listing) or none.
   * buildArgs only emits a `--variant` the list actually contains.
   */
  reasoningOptions?: ModelReasoningOption[];
}

/** One advertised reasoning choice (`{ id: "high", label: "high" }`). */
export interface ModelReasoningOption {
  id: string;
  label?: string;
}

export interface ModelDefinition {
  /** Static fallback list when live discovery fails */
  fallbackModels: RuntimeModel[];
  /** Command to list models live (e.g. `opencode models`) */
  listCommand?: string[];
}

/**
 * Model ids travel as CLI argv values (`--model <id>`), so a hostile id
 * like `--dangerously-skip-permissions` would be parsed as a flag by the
 * agent CLI. Accept the daemon's charset: must start alphanumerical,
 * then alphanumerics plus `._/:@-` (covers `sonnet`, `gpt-5.4-mini`,
 * `anthropic/claude-sonnet-4-5`, `provider/model@tag`), max 200 chars.
 * Returns the trimmed id, or null when it must not reach argv.
 * Pure (no throw) — adapters reject null loudly at buildArgs time.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const MAX_MODEL_ID_LENGTH = 200;

export function sanitizeModelId(id: string | null | undefined): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_LENGTH) return null;
  if (!MODEL_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}
