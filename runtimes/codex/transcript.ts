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

export interface CodexTranscriptOptions extends HistoryOptions {
  /** Thread id (`thread.started` → `session_started.sessionId`). */
  sessionId: string;
  /** Home override (honors `$CODEX_HOME` like the config path). */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Recent day-dirs to scan, newest first (default 14). */
  maxDays?: number;
}

/**
 * Read a codex thread's history from rollout JSONL
 * (`<home>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, verified against
 * codex-cli 0.150.1). Only `item_completed` items are folded — they are the
 * terminal record (`response_item` streams would double-count). Reasoning
 * items are dropped (displayed via `reasoning_delta`, never history).
 * Images are skipped. Fail-open: missing/unparseable files yield [].
 */
export function readCodexTranscript(options: CodexTranscriptOptions): TranscriptEntry[] {
  const file = findCodexRollout(options);
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return selectHistory(parseCodexRollout(text), options);
}

/**
 * Locate the rollout file for a thread: filename embeds the thread id
 * (verified live), with a `session_meta` content fallback. Newest day-dirs
 * first, bounded by `maxDays`.
 */
export function findCodexRollout(options: CodexTranscriptOptions): string | null {
  const env = options.env ?? process.env;
  const home = options.codexHome ?? env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const root = join(home, "sessions");
  const days = listDayDirs(root, options.maxDays ?? 14);
  const fallback: string[] = [];
  for (const day of days) {
    let files: string[] = [];
    try {
      files = readdirSync(day)
        .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.includes(options.sessionId)) return join(day, file);
      if (fallback.length < 50) fallback.push(join(day, file));
    }
  }
  // Filename missed (older layout?) — match session_meta content instead.
  for (const file of fallback) {
    try {
      const head = readFileSync(file, "utf-8").split("\n", 5).join("\n");
      if (head.includes(options.sessionId)) return file;
    } catch {
      continue;
    }
  }
  return null;
}

/** Newest-first `<yyyy>/<mm>/<dd>` dirs under the sessions root. */
function listDayDirs(root: string, maxDays: number): string[] {
  const out: string[] = [];
  let years: string[] = [];
  try {
    years = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return out;
  }
  for (const year of years) {
    let months: string[] = [];
    try {
      months = readdirSync(join(root, year), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const month of months) {
      let days: string[] = [];
      try {
        days = readdirSync(join(root, year, month), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const day of days) {
        out.push(join(root, year, month, day));
        if (out.length >= maxDays) return out;
      }
    }
  }
  return out;
}

/** Fold rollout JSONL text into compact entries (pure, unit-tested). */
export function parseCodexRollout(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const entry = foldCodexLine(obj);
    if (entry) entries.push(entry);
  }
  return entries;
}

function foldCodexLine(obj: unknown): TranscriptEntry | null {
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const payload = (rec["payload"] as Record<string, unknown> | undefined) ?? undefined;
  if (rec["type"] !== "event_msg" || payload?.["type"] !== "item_completed") return null;
  const item = payload["item"] as Record<string, unknown> | undefined;
  if (!item || typeof item["type"] !== "string") return null;
  const timestamp = toMs((obj as Record<string, unknown>)["timestamp"]);
  switch (item["type"]) {
    case "UserMessage":
      return textEntry("user", messageText(item), timestamp);
    case "AgentMessage":
      return textEntry("assistant", messageText(item), timestamp);
    case "CommandExecution": {
      const command = typeof item["command"] === "string" ? item["command"] : "command";
      const exit =
        typeof item["exit_code"] === "number" ? ` (exit ${String(item["exit_code"])})` : "";
      const output =
        typeof item["aggregated_output"] === "string" && item["aggregated_output"].trim().length > 0
          ? `\n${truncateTranscriptText(item["aggregated_output"].trim(), 200)}`
          : "";
      return {
        role: "tool",
        toolName: "exec",
        text: `${command}${exit}${output}`,
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    }
    case "FileChange": {
      const changes = Array.isArray(item["changes"])
        ? item["changes"]
            .map((c) => {
              const r = c as Record<string, unknown>;
              return typeof r["path"] === "string" ? r["path"] : null;
            })
            .filter((p): p is string => p !== null)
            .join(", ")
        : "";
      return {
        role: "tool",
        toolName: "edit",
        text: changes ? `changed: ${changes}` : "changed files",
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    }
    case "Reasoning":
      return null; // thinking lives on reasoning_delta, never in history
    default: {
      // McpToolCall / WebSearch / TodoList / future kinds: name + nothing.
      const name = typeof item["title"] === "string" ? item["title"] : item["type"];
      return {
        role: "tool",
        toolName: name,
        text: "",
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    }
  }
}

function messageText(item: Record<string, unknown>): string {
  const content = item["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c !== "object" || c === null) return "";
      const r = c as Record<string, unknown>;
      if (
        (r["type"] === "input_text" || r["type"] === "output_text") &&
        typeof r["text"] === "string"
      ) {
        return r["text"];
      }
      return "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

function textEntry(
  role: "user" | "assistant",
  text: string,
  timestamp: number | undefined,
): TranscriptEntry | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    role,
    text: truncateTranscriptText(trimmed),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

export function codexSessionsDir(
  options: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  const home = options.codexHome ?? env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return join(home, "sessions");
}
