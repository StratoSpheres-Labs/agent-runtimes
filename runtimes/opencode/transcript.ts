import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// NOTE: `node:sqlite` is imported lazily inside `readOpencodeTranscript`
// (never top-level): it needs node >= 22.5 and must not break module load
// on node 20. The type import below is fully erased at runtime.
import type { DatabaseSync } from "node:sqlite";
import {
  selectHistory,
  toMs,
  truncateTranscriptText,
  type HistoryOptions,
  type TranscriptEntry,
} from "../../src/definition/transcript.js";

export interface OpencodeTranscriptOptions extends HistoryOptions {
  /** Native session id (`step_start` → `session_started.sessionId`). */
  sessionId: string;
  /** Data-dir override (default `~/.local/share/opencode`). */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read an opencode session's history from `opencode.db`
 * (`message` + `part` tables keyed by `session_id`, verified live against
 * opencode 1.18.31). One entry per message: user/assistant text joined,
 * each completed/errored tool compressed to one line. Reasoning, step
 * markers, snapshots, and patches are dropped; file/image parts skipped.
 * Read-only open; missing DB, locked DB, old node, or schema drift all
 * fail open to [].
 */
// Sync body, async for interface parity.
// eslint-disable-next-line @typescript-eslint/require-await
export async function readOpencodeTranscript(
  options: OpencodeTranscriptOptions,
): Promise<TranscriptEntry[]> {
  const db = openOpencodeDb(opencodeDbPath(options));
  if (!db) return [];
  try {
    return selectHistory(readSession(db, options.sessionId), options);
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close errors on a read-only handle.
    }
  }
}

export function opencodeDbPath(
  options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  const base =
    options.dataDir ?? env["OPENCODE_DATA_DIR"] ?? join(homedir(), ".local", "share", "opencode");
  return join(base, "opencode.db");
}

function openOpencodeDb(path: string): DatabaseSync | null {
  // NOTE: no dynamic import() here — tsup/esbuild rewrites
  // `import("node:sqlite")` to `import("sqlite")` in the bundle, which
  // never resolves. require() via createRequire survives bundling untouched.
  // Structural constructor type keeps this free of import() annotations.
  type SqliteDb = new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: SqliteDb;
    };
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    // node < 22.5 (no built-in sqlite), or a missing/locked/corrupt DB —
    // history unavailable, not an error.
    return null;
  }
}

function readSession(db: DatabaseSync, sessionId: string): TranscriptEntry[] {
  let messages: Array<{ id: string; role: string; time: unknown }>;
  try {
    messages = (
      db
        .prepare(
          "SELECT id, data, time_created AS time FROM message WHERE session_id = ? ORDER BY time_created",
        )
        .all(sessionId) as Array<{ id: string; data: string; time: unknown }>
    ).map((m) => {
      let role = "";
      try {
        role = (JSON.parse(m.data) as { role?: unknown })["role"] as string;
      } catch {
        role = "";
      }
      return { id: m.id, role: typeof role === "string" ? role : "", time: m.time };
    });
  } catch {
    return []; // Schema drift (table/columns renamed upstream).
  }
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    foldMessage(db, message, entries);
  }
  return entries;
}

function foldMessage(
  db: DatabaseSync,
  message: { id: string; role: string; time: unknown },
  entries: TranscriptEntry[],
): void {
  let parts: Array<Record<string, unknown>>;
  try {
    parts = (
      db
        .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created")
        .all(message.id) as Array<{ data: string }>
    ).map((p) => {
      try {
        return JSON.parse(p.data) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  } catch {
    return;
  }
  const timestamp = toMs(message.time);
  const texts: string[] = [];
  for (const part of parts) {
    if (part["type"] === "text" && typeof part["text"] === "string") {
      texts.push(part["text"]);
    } else if (part["type"] === "tool") {
      const tool = foldToolPart(part, timestamp);
      if (tool) entries.push(tool);
    }
    // reasoning / step-start / step-finish / snapshot / patch / file: skipped.
  }
  const joined = texts.join("\n").trim();
  if (joined) {
    entries.push({
      role: message.role as "user" | "assistant",
      text: truncateTranscriptText(joined),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }
}

function foldToolPart(
  part: Record<string, unknown>,
  timestamp: number | undefined,
): TranscriptEntry | null {
  const state = part["state"] as Record<string, unknown> | undefined;
  const status = typeof state?.["status"] === "string" ? state["status"] : "";
  // Pending/running parts duplicate the later completed line — skip them.
  if (status !== "completed" && status !== "error") return null;
  const name = typeof part["tool"] === "string" ? part["tool"] : "tool";
  const output = typeof state?.["output"] === "string" ? state["output"].trim() : "";
  const failed = status === "error";
  const text = output ? `${name}: ${truncateTranscriptText(output, 200)}` : `${name}: ${status}`;
  return {
    role: "tool",
    toolName: name,
    text: failed && !output ? `${text} (failed)` : text,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}
