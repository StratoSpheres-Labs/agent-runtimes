import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimePlugin } from "../definition/plugin.js";

/** Cap on config bytes read (plugin lists live at the head; bodies unneeded). */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
/** Cap on entries taken per config file / per plugin dir (runaway-proof). */
const MAX_ENTRIES_PER_SOURCE = 100;
const MAX_ID_LENGTH = 200;

export interface PluginSearchOptions {
  homeDir?: string;
  /** e.g. XDG_CONFIG_HOME — when set, replaces `~/.config` for the global root. */
  configDir?: string;
  /** Project root — enables project config + `<cwd>/.opencode/plugins`. */
  cwd?: string;
}

export interface PluginConfigFile {
  file: string;
  source: RuntimePlugin["source"];
}

export interface PluginDir {
  dir: string;
  source: RuntimePlugin["source"];
}

/**
 * Config files in merge order (global first, then project). Pure (no fs).
 * Both `.json` and `.jsonc` are candidates — opencode accepts either.
 */
export function pluginConfigFiles(options: PluginSearchOptions = {}): PluginConfigFile[] {
  const out: PluginConfigFile[] = [];
  const home = options.homeDir ?? homedir();
  const configBase = options.configDir ?? (home ? join(home, ".config") : null);
  if (configBase) {
    const dir = join(configBase, "opencode");
    out.push({ file: join(dir, "opencode.json"), source: "global" });
    out.push({ file: join(dir, "opencode.jsonc"), source: "global" });
  }
  if (options.cwd) {
    const root = resolve(options.cwd);
    out.push({ file: join(root, "opencode.json"), source: "project" });
    out.push({ file: join(root, "opencode.jsonc"), source: "project" });
  }
  return out;
}

/**
 * Local plugin directories (global + project). Pure (no fs).
 */
export function pluginSearchDirs(options: PluginSearchOptions = {}): PluginDir[] {
  const out: PluginDir[] = [];
  const home = options.homeDir ?? homedir();
  const configBase = options.configDir ?? (home ? join(home, ".config") : null);
  if (configBase) out.push({ dir: join(configBase, "opencode", "plugins"), source: "global" });
  if (options.cwd)
    out.push({ dir: resolve(options.cwd, ".opencode", "plugins"), source: "project" });
  return out;
}

/**
 * Minimal JSONC comment stripper: line comments and block comments, with
 * strings respected (escapes honored). Anything fancier degrades downstream
 * to fail-open instead of throwing here.
 */
export function stripJsoncComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Layered parse: strict JSON, then JSONC, then JSONC + trailing commas. */
function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to lenient layers
  }
  const stripped = stripJsoncComments(text);
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    // fall through
  }
  try {
    return JSON.parse(stripped.replace(/,\s*([}\]])/g, "$1")) as unknown;
  } catch {
    return null;
  }
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  return id;
}

/**
 * Parse a config `plugin` array: `"name"` strings and `["name", {...}]`
 * tuples per the official schema. Non-conforming entries are skipped,
 * never fatal. Pure — safe to unit test.
 */
export function parsePluginEntries(
  value: unknown,
  source: RuntimePlugin["source"],
): RuntimePlugin[] {
  if (!Array.isArray(value)) return [];
  const out: RuntimePlugin[] = [];
  for (const entry of value.slice(0, MAX_ENTRIES_PER_SOURCE)) {
    if (typeof entry === "string") {
      const id = cleanId(entry);
      if (id) out.push({ id, source, kind: "npm" });
      continue;
    }
    if (Array.isArray(entry) && entry.length >= 1) {
      const id = cleanId(entry[0]);
      if (id) out.push({ id, source, kind: "npm", hasConfig: true });
    }
    // Anything else (objects, numbers) is not schema — skip.
  }
  return out;
}

/** Read one config file's `plugin` array. Fail-open: [] on any problem. */
export function readPluginConfigFile(config: PluginConfigFile): RuntimePlugin[] {
  let size = 0;
  try {
    size = statSync(config.file).size;
  } catch {
    return [];
  }
  if (size <= 0 || size > MAX_CONFIG_FILE_BYTES) return [];
  let text: string;
  try {
    text = readFileSync(config.file, "utf-8");
  } catch {
    return [];
  }
  const parsed = parseLenientJson(text);
  if (typeof parsed !== "object" || parsed === null) return [];
  return parsePluginEntries((parsed as Record<string, unknown>)["plugin"], config.source);
}

/**
 * Merge config-array entries (explicit declarations win) with local
 * plugin directories. Read-only, fail-open: missing/unreadable sources
 * yield no entries (never throw).
 */
export function discoverPlugins(
  configFiles: PluginConfigFile[],
  pluginDirs: PluginDir[],
): RuntimePlugin[] {
  const out: RuntimePlugin[] = [];
  const seen = new Set<string>();
  const push = (p: RuntimePlugin): void => {
    const key = `${p.source}:${p.id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const config of configFiles) {
    for (const p of readPluginConfigFile(config)) push(p);
  }
  for (const root of pluginDirs) {
    let entries: string[];
    try {
      if (!existsSync(root.dir)) continue;
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    let scanned = 0;
    for (const name of entries.sort()) {
      if (scanned >= MAX_ENTRIES_PER_SOURCE) break;
      const id = name.trim();
      // Directory names only — skip dotfiles and odd entries.
      if (!/^[A-Za-z0-9@][^/\\]*$/.test(id) || id.length > MAX_ID_LENGTH) continue;
      // Must be a directory (plugin files live in folders, not loose files).
      try {
        if (!statSync(join(root.dir, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      scanned += 1;
      push({ id, source: root.source, kind: "local" });
    }
  }
  return out;
}
