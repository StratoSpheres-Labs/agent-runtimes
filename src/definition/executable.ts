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
  /**
   * npm registry id for update checks (e.g. `"@anthropic-ai/claude-code"`).
   * npm/pnpm/bun installs all resolve upstream through the npm registry, so
   * one id covers every manager. Absent = not checkable (winget/brew-only
   * installs stay `unknown`).
   */
  registryId?: string;
  /**
   * Args that print help for capability probing, default `["--help"]`.
   * Some CLIs only document subcommand flags under the subcommand
   * (e.g. claude's `--add-dir` lives under `claude -p --help`, never in the
   * top-level help) — those adapters declare their help argv here.
   */
  helpArgs?: string[];
  /**
   * Known install locations outside PATH, consulted after PATH hits (never
   * instead of them). Absolute paths, or `~`-prefixed for the user home
   * (e.g. `~/Applications/Codex.app/Contents/Resources/codex`).
   * Platform-specific entries are fine — nonexistent paths are skipped, so a
   * macOS bundle path is harmless on Windows. Keep it to a handful of
   * well-known spots; version managers and bun dirs live in toolchain.ts.
   */
  extraProbePaths?: string[];
}
