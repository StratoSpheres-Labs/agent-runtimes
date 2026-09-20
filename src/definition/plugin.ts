/**
 * Agent-agnostic plugin descriptor — read-only discovery.
 * For opencode, plugins come from two places (see
 * https://opencode.ai/docs/config/#plugins):
 * - the `plugin` array in `opencode.json` (npm modules: `"name"` or
 *   `["name", { ...inlineConfig }]` tuples),
 * - local plugin directories (`~/.config/opencode/plugins/`,
 *   `<project>/.opencode/plugins/`).
 * Only metadata is surfaced — never file contents or inline secrets.
 */
export interface RuntimePlugin {
  /** npm module name, local directory name, or `name@marketplace` id. */
  id: string;
  /** Where the plugin was declared (`user` scope maps to `global`). */
  source: "global" | "project";
  /**
   * `npm` = config `plugin` array entry, `local` = plugins/ directory,
   * `marketplace` = manager-installed (e.g. `claude plugin list`).
   */
  kind: "npm" | "local" | "marketplace";
  /** True for `["name", {...}]` tuple entries (inline config present). */
  hasConfig?: boolean;
  /** Installed version, when the agent reports it. */
  version?: string;
  /** Whether the agent has the plugin enabled, when reported. */
  enabled?: boolean;
  /** Project the plugin is scoped to, when it is project-scoped. */
  projectPath?: string;
}
