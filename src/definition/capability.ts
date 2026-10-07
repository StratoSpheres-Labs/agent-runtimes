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
  /**
   * Exposes workspace allowlist / permission / sandbox gating.
   * False means `workspace` inputs are rejected loudly at session
   * creation (never silently ignored) — see `hasWorkspaceFields`.
   */
  workspace: boolean;
  /** Select a named agent/persona (opencode `--agent`) */
  agentSelection: boolean;
  /** Append input while a run is in flight (`run.send()`) */
  midRunInput: boolean;
  /** Seed a fresh session with prior messages (`seedMessages`) */
  historySeed: boolean;
  /**
   * `history()` can nest sub-agent transcripts under the tool call that
   * dispatched them (`HistoryOptions.includeSubAgents`).
   *
   * False means the CLI's own transcript store cannot be walked back to the
   * runs a session dispatched — not merely "not implemented yet". Do not set it
   * on the strength of the CLI's *prompts* mentioning sub-agents: the test is
   * whether real recorded child runs can be read back and tied to their
   * spawning tool call.
   */
  subAgents: boolean;
  /** Caller-supplied system prompt */
  systemPrompt: boolean;
  /** Caller-supplied output token budget (`maxTokens`) */
  maxTokens: boolean;
  /**
   * Caller-supplied cost budget in USD (`maxBudgetUsd`, claude
   * `--max-budget-usd`). Cost, not tokens — never conflate the two.
   */
  costBudget: boolean;
  /**
   * Caller-supplied JSON Schema constraining the final message
   * (`outputSchema`: codex `--output-schema` file, claude `--json-schema`
   * inline). The constrained text still arrives as `text_delta` — callers
   * `JSON.parse` it; the channel only raises the hit rate, never a type.
   */
  structuredOutput: boolean;
  /** Caller-supplied tool allowlist (`allowedTools`) */
  toolAllowlist: boolean;
  /** Select a named config profile (codex `-p/--profile`) */
  profileSelection: boolean;
}
