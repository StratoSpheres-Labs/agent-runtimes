import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// NOTE: `node:sqlite` is imported lazily inside `readOpencodeTranscript`
// (never top-level): it needs node >= 22.5 and must not break module load
// on node 20. The type import below is fully erased at runtime.
import type { DatabaseSync } from "node:sqlite";
import {
  redactTranscriptEntries,
  resolveMaxDepth,
  selectHistory,
  toMs,
  truncateTranscriptText,
  type HistoryOptions,
  type SubAgentTurn,
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
    // Sub-agents are opt-in (see HistoryOptions.includeSubAgents): they
    // multiply the returned text and carry the same pasted-secret exposure as
    // the parent. Off means no `session.parent_id` query runs at all.
    const scope =
      options.includeSubAgents === true
        ? planSubAgents(db, options.sessionId, resolveMaxDepth(options.maxDepth))
        : undefined;
    return redactTranscriptEntries(
      selectHistory(readSession(db, options.sessionId, scope), options),
      options.includeRawInputs,
    );
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

function readSession(
  db: DatabaseSync,
  sessionId: string,
  subAgents?: SubAgentScope,
): TranscriptEntry[] {
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
    foldMessage(db, message, entries, subAgents);
  }
  return entries;
}

/** A dispatched sub-agent session row. */
interface ChildSession {
  readonly id: string;
  readonly agent?: string;
  readonly title?: string;
  readonly time?: number;
}

/**
 * Which `task` tool calls dispatched which children, for one session.
 *
 * Built before folding so a tool entry can carry its children as it is
 * emitted. Empty maps mean "looked, found none" — the caller still attaches no
 * `subAgents` key at all, which is the documented "absent, not empty" shape.
 */
interface SubAgentScope {
  /** Tool part `callID` → child sessions it dispatched, in creation order. */
  readonly dispatchedBy: ReadonlyMap<string, readonly ChildSession[]>;
  /** Nesting levels still available below this session's children. */
  readonly remainingDepth: number;
  readonly db: DatabaseSync;
}

/**
 * Find the children of `sessionId` and tie each to the tool call that spawned it.
 *
 * The correlation is the load-bearing part. opencode records the child session
 * id inside the `task` tool part's own output (`<task id="ses_…" …>`), which is
 * the only link between the two — `session.parent_id` gives the parent→child
 * direction but nothing that says *which call* dispatched it.
 *
 * A child with no matching `task` part is **dropped**, not attached to a
 * plausible-looking call. Measured on a real store: 65 of 76 children tie
 * cleanly and 11 do not (the parent's task part is absent — compacted or
 * rotated). Guessing those onto a neighbouring `task` call would put a real
 * transcript under the wrong prompt, and nothing downstream could detect it.
 */
function planSubAgents(db: DatabaseSync, sessionId: string, remainingDepth: number): SubAgentScope {
  const empty: SubAgentScope = { dispatchedBy: new Map(), remainingDepth, db };
  if (remainingDepth < 0) return empty;

  let children: ChildSession[];
  try {
    children = (
      db
        .prepare(
          "SELECT id, agent, title, time_created FROM session WHERE parent_id = ? ORDER BY time_created",
        )
        .all(sessionId) as Array<{
        id: string;
        agent?: string | null;
        title?: string | null;
        time_created?: unknown;
      }>
    ).map((row) => ({
      id: row.id,
      ...(typeof row.agent === "string" && row.agent.length > 0 ? { agent: row.agent } : {}),
      ...(typeof row.title === "string" && row.title.length > 0 ? { title: row.title } : {}),
      ...(() => {
        const t = toMs(row.time_created);
        return t === undefined ? {} : { time: t };
      })(),
    }));
  } catch {
    return empty; // No `session` table, or schema drift.
  }
  if (children.length === 0) return empty;

  // One pass over the session's `task` parts, matched by substring against the
  // child ids. Substring matching on an opaque `ses_…` id is safe here: the ids
  // are same-length tokens from the same generator, so one cannot be a prefix of
  // another in practice, and a miss costs a dropped child rather than a wrong
  // parent.
  let taskParts: Array<{ callId: string; raw: string }>;
  try {
    taskParts = (
      db.prepare("SELECT data FROM part WHERE session_id = ?").all(sessionId) as Array<{
        data: string;
      }>
    )
      .map((row) => {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (parsed["type"] !== "tool" || parsed["tool"] !== "task") return undefined;
          const callId = parsed["callID"];
          return typeof callId === "string" ? { callId, raw: row.data } : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is { callId: string; raw: string } => p !== undefined);
  } catch {
    return empty;
  }
  if (taskParts.length === 0) return empty;

  const dispatchedBy = new Map<string, ChildSession[]>();
  for (const child of children) {
    for (const part of taskParts) {
      if (!part.raw.includes(child.id)) continue;
      const bucket = dispatchedBy.get(part.callId);
      if (bucket === undefined) dispatchedBy.set(part.callId, [child]);
      else bucket.push(child);
      break; // One owning call per child, even if the id appears twice.
    }
  }
  return { dispatchedBy, remainingDepth, db };
}

/** Materialize the child transcripts a `task` tool call dispatched. */
function attachSubAgents(scope: SubAgentScope, callId: string): SubAgentTurn[] | undefined {
  const children = scope.dispatchedBy.get(callId);
  if (children === undefined || children.length === 0) return undefined;
  const turns: SubAgentTurn[] = [];
  for (const child of children) {
    const nested =
      scope.remainingDepth > 0
        ? planSubAgents(scope.db, child.id, scope.remainingDepth - 1)
        : { dispatchedBy: new Map(), remainingDepth: 0, db: scope.db };
    turns.push({
      id: child.id,
      ...(child.agent !== undefined ? { name: child.agent } : {}),
      ...(child.title !== undefined ? { title: child.title } : {}),
      entries: readSession(scope.db, child.id, nested),
      ...(child.time !== undefined ? { timestamp: child.time } : {}),
      depth: 0,
    });
  }
  return turns;
}

function foldMessage(
  db: DatabaseSync,
  message: { id: string; role: string; time: unknown },
  entries: TranscriptEntry[],
  subAgents?: SubAgentScope,
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
      if (!tool) continue;
      // Nest under the `task` call that dispatched the child, and only there.
      const callId = part["callID"];
      const nested =
        subAgents !== undefined && typeof callId === "string"
          ? attachSubAgents(subAgents, callId)
          : undefined;
      if (nested !== undefined) entries.push({ ...tool, subAgents: nested });
      else entries.push(tool);
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
