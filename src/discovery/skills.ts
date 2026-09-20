import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { RuntimeSkill } from "../definition/skill.js";

/** Cap on scanned skill dirs per root (a runaway dir must not stall discovery). */
const MAX_SKILLS_PER_ROOT = 50;
/** Cap on SKILL.md bytes read (frontmatter lives at the head; body is never needed). */
const MAX_SKILL_FILE_BYTES = 64 * 1024;

export interface SkillSearchOptions {
  homeDir?: string;
  /** e.g. XDG_CONFIG_HOME — when set, replaces `~/.config` for the global root. */
  configDir?: string;
  /** Project root — enables the `<cwd>/.opencode/skills` root. */
  cwd?: string;
}

/**
 * Skill roots in priority order: global first, then project.
 * Pure (no fs) — safe to unit test.
 */
export function skillSearchDirs(options: SkillSearchOptions = {}): string[] {
  const out: string[] = [];
  const home = options.homeDir ?? homedir();
  const configBase = options.configDir ?? (home ? join(home, ".config") : null);
  if (configBase) out.push(join(configBase, "opencode", "skills"));
  if (options.cwd) out.push(resolve(options.cwd, ".opencode", "skills"));
  return out;
}

/**
 * Minimal frontmatter reader: only the leading `---` block, only `name:` /
 * `description:` scalar lines. No yaml dependency; anything fancier degrades
 * to id-only instead of throwing.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const head = text.slice(0, MAX_SKILL_FILE_BYTES);
  if (!head.startsWith("---")) return {};
  const end = head.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = head.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = line.slice(colon + 1).trim();
    // Strip matching single/double quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;
    if (key === "name" && out.name === undefined) out.name = value;
    if (key === "description" && out.description === undefined) out.description = value;
  }
  return out;
}

function readSkillFile(file: string): { name?: string; description?: string } | null {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  if (size <= 0 || size > 8 * MAX_SKILL_FILE_BYTES) return null;
  try {
    return parseSkillFrontmatter(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * An explicit skill root. Adapters build these (their paths differ per
 * agent); plain strings keep the legacy opencode suffix inference.
 */
export interface SkillRoot {
  dir: string;
  source: RuntimeSkill["source"];
}

/**
 * Scan skill roots for `<id>/SKILL.md` entries. Read-only, fail-open:
 * missing/unreadable roots yield no entries (never throw).
 */
export function discoverSkills(roots: Array<string | SkillRoot>): RuntimeSkill[] {
  const out: RuntimeSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const dir = typeof root === "string" ? root : root.dir;
    const source: RuntimeSkill["source"] =
      typeof root === "string"
        ? dir.endsWith(join(".opencode", "skills"))
          ? "project"
          : "global"
        : root.source;
    let entries: string[];
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    let scanned = 0;
    for (const name of entries.sort()) {
      if (scanned >= MAX_SKILLS_PER_ROOT) break;
      const id = name.trim();
      // Directory names only — skip dotfiles and odd entries.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
      const key = `${source}:${id.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = join(dir, id, "SKILL.md");
      let meta: { name?: string; description?: string } | null = null;
      try {
        if (!existsSync(file)) continue;
        meta = readSkillFile(file);
      } catch {
        continue;
      }
      if (meta === null) continue;
      scanned += 1;
      const abs = isAbsolute(file) ? file : resolve(file);
      out.push({
        id,
        name: meta.name ?? id,
        ...(meta.description ? { description: meta.description } : {}),
        source,
        path: abs,
      });
    }
  }
  return out;
}
