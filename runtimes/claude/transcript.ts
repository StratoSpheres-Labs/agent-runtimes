import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  selectHistory,
  toMs,
  truncateTranscriptText,
  type HistoryOptions,
  type TranscriptEntry,
} from "../../src/definition/transcript.js";

export interface ClaudeTranscriptOptions extends HistoryOptions {
  /** Native session id (`system/init` → `session_started.sessionId`). */
  sessionId: string;
  /** Working directory the session ran in (locates the transcript dir). */
  cwd?: string;
  /** Home override for `~/.claude`. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read a Claude Code session's history from its transcript JSONL
 * (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`). Only `user` /
 * `assistant` lines fold into entries; thinking blocks, hooks, summaries,
 * and queue machinery are skipped. `tool_result` blocks pair with the
 * earlier `tool_use` name; unpaired results file under `"tool"`.
 * Fail-open: missing/unparseable files yield [].
 */
export function readClaudeTranscript(options: ClaudeTranscriptOptions): TranscriptEntry[] {
  const file = findClaudeTranscript(options);
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return selectHistory(parseClaudeTranscript(text), options);
}

/**
 * Locate the transcript: slug path first (`cwd` with every non-alphanumeric
 * char → `-`, verified live: `D:\AAA_Dev\x` → `D--AAA-Dev-x`), then a
 * bounded scan of all project dirs for `<sessionId>.jsonl` (immune to
 * slug-rule drift across CLI versions).
 */
export function findClaudeTranscript(options: ClaudeTranscriptOptions): string | null {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env["HOME"] ?? env["USERPROFILE"] ?? homedir();
  const root = join(home, ".claude", "projects");
  if (options.cwd) {
    const slug = options.cwd.replace(/[^A-Za-z0-9]/g, "-");
    try {
      const direct = join(root, slug, `${options.sessionId}.jsonl`);
      readFileSync(direct, "utf-8");
      return direct;
    } catch {
      // Fall through to the scan below.
    }
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(dir, `${options.sessionId}.jsonl`);
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Fold transcript JSONL text into compact entries (pure, unit-tested). */
export function parseClaudeTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    foldClaudeLine(obj, toolNames, entries);
  }
  return entries;
}

function foldClaudeLine(
  obj: unknown,
  toolNames: Map<string, string>,
  entries: TranscriptEntry[],
): void {
  if (typeof obj !== "object" || obj === null) return;
  const rec = obj as Record<string, unknown>;
  const type = rec["type"];
  if (type !== "user" && type !== "assistant") return;
  const timestamp = toMs(rec["timestamp"]);
  const message = rec["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (typeof content === "string") {
    pushText(entries, type, content, timestamp);
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      texts.push(b["text"]);
    } else if (b["type"] === "tool_use") {
      // Stash the name; the entry lands when its tool_result arrives.
      const id = typeof b["id"] === "string" ? b["id"] : null;
      const name = typeof b["name"] === "string" ? b["name"] : "tool";
      if (id) toolNames.set(id, name);
      else entries.push(toolEntry(name, "", undefined));
    } else if (b["type"] === "tool_result") {
      const id = typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : null;
      const name = (id && toolNames.get(id)) || "tool";
      if (id) toolNames.delete(id);
      entries.push(toolEntry(name, toolResultText(b["content"]), timestamp));
    }
    // thinking / image / redacted blocks: skipped (reasoning has reasoning_delta).
  }
  const joined = texts.join("\n").trim();
  if (joined) {
    entries.push({
      role: type,
      text: truncateTranscriptText(joined),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }
}

function pushText(
  entries: TranscriptEntry[],
  role: "user" | "assistant",
  text: string,
  timestamp: number | undefined,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  entries.push({
    role,
    text: truncateTranscriptText(trimmed),
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
}

function toolEntry(name: string, text: string, timestamp: number | undefined): TranscriptEntry {
  return {
    role: "tool",
    toolName: name,
    text: truncateTranscriptText(text.trim()),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c !== "object" || c === null) return "";
      const r = c as Record<string, unknown>;
      return typeof r["text"] === "string" ? r["text"] : "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}
