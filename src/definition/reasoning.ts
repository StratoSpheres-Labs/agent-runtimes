/**
 * Phase 17 — unified reasoning controls.
 * Callers use `reasoning.effort`; each adapter maps it to its own
 * CLI mechanism (opencode `--variant`, codex `-c model_reasoning_effort`,
 * claude thinking configuration). Raw `thinking` / `variant` / `effort`
 * flags must never appear in public API (Rule 2).
 */
export type ReasoningEffort = "low" | "medium" | "high";

export interface ReasoningOptions {
  effort: ReasoningEffort;
}
