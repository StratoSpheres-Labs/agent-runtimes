/**
 * Agent-agnostic skill descriptor — read-only discovery.
 * A skill is a directory carrying a `SKILL.md` with `name`/`description`
 * frontmatter (verified on opencode: `~/.config/opencode/skills/<id>/SKILL.md`).
 * Only metadata is surfaced — never the instruction body.
 */
export interface RuntimeSkill {
  /** Directory name, e.g. "frontend-design". */
  id: string;
  /** Frontmatter `name`, falling back to `id` when absent. */
  name: string;
  /** Frontmatter `description` (first line, trimmed). */
  description?: string;
  /** Where the skill was found. */
  source: "global" | "project";
  /** Absolute path to the `SKILL.md` file. */
  path: string;
}
