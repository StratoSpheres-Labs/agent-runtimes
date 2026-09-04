/**
 * How to locate and probe the CLI executable.
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md Task 1.2
 */
export interface ExecutableDefinition {
  /** Primary binary name on PATH, e.g. "opencode", "claude" */
  command: string;
  /** Alternative binary names (e.g. aliases or platform variants) */
  aliases?: string[];
  /** Args that print version to stdout/stderr, default ["--version"] */
  versionArgs?: string[];
}
