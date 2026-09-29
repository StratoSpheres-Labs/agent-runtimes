import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getSessionStoreDir } from "./session-store.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import { isRuntimeEvent } from "../wire.js";
import { silentLogger, type RuntimeLogger } from "../definition/logger.js";

/**
 * Run journal — crash-safe per-session event log (P0 middleware foundation).
 * Every event a run emits is appended here as NDJSON (`{seq, event}`), so a
 * dead host loses nothing but its process: after restart, `readJournal`
 * replays the ground truth and `journalIncomplete` tells whether the last
 * turn ever reached `done`. Upper layers (BFF sync, audit, replay UI) tail
 * these files directly — same framing as the wire (`docs/frontend.md`).
 *
 * Keyed by library session id (stable across processes, NOT the native id:
 * a cross-restart native resume mints a new local session and therefore a
 * new journal — documented, not hidden). Best-effort on write (never
 * throws, never fails a turn); strict on read (torn tails skipped).
 */

export interface JournalEventLine {
  seq: number;
  event: RuntimeEvent;
}

export interface JournalAbortedLine {
  seq: number;
  aborted: true;
}

export type JournalLine = JournalEventLine | JournalAbortedLine;

/** Cap per journal file — beyond it the oldest lines compact away. */
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
/** Journals untouched longer than this are reaped on read. */
export const JOURNAL_RETAIN_DAYS = 30;
/** Lines kept by a compaction pass. */
const JOURNAL_COMPACT_KEEP_LINES = 1000;

function journalPath(sessionId: string, dir?: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(dir ?? getSessionStoreDir(), `${safe}.journal.ndjson`);
}

/** In-memory next-seq per file (crash resets it — re-derived from disk). */
const nextSeqCache = new Map<string, number>();

function nextSeq(file: string): number {
  const cached = nextSeqCache.get(file);
  if (cached !== undefined) return cached;
  let seq = 1;
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf-8");
      let max = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { seq?: unknown };
          if (typeof obj.seq === "number" && obj.seq > max) max = obj.seq;
        } catch {
          // Torn tail — ignored for sequencing (skipped on read too).
        }
      }
      seq = max + 1;
    } catch {
      seq = 1;
    }
  }
  nextSeqCache.set(file, seq);
  return seq;
}

/**
 * Append one event. Never throws: I/O failures degrade to a logger warn
 * (the turn must not die because observability did).
 */
export function appendJournalEvent(
  sessionId: string,
  event: RuntimeEvent,
  opts: { dir?: string; logger?: RuntimeLogger } = {},
): void {
  const log = opts.logger ?? silentLogger;
  try {
    const file = journalPath(sessionId, opts.dir);
    mkdirSync(dirname(file), { recursive: true });
    const seq = nextSeq(file);
    appendFileSync(file, `${JSON.stringify({ seq, event })}\n`, "utf-8");
    nextSeqCache.set(file, seq + 1);
    compactJournalIfNeeded(file);
  } catch (err) {
    log.warn("journal-append-failed", {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Drop the cached seq (tests only — isolates temp-dir cases). */
export function clearJournalSeqCache(): void {
  nextSeqCache.clear();
}

function parseJournalLine(line: string): JournalLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // Torn tail from a mid-write crash.
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec["seq"] !== "number") return null;
  if (rec["aborted"] === true) return { seq: rec["seq"], aborted: true };
  if (isRuntimeEvent(rec["event"])) return { seq: rec["seq"], event: rec["event"] };
  return null;
}

/**
 * Read a session journal, oldest first. Tolerates torn tails and foreign
 * lines (skipped). Enforces retention: a file untouched longer than
 * `JOURNAL_RETAIN_DAYS` is reaped and reads as empty.
 */
export function readJournal(sessionId: string, opts: { dir?: string } = {}): JournalLine[] {
  const file = journalPath(sessionId, opts.dir);
  if (!existsSync(file)) return [];
  try {
    const mtime = statSync(file).mtimeMs;
    if (Date.now() - mtime > JOURNAL_RETAIN_DAYS * 24 * 3600 * 1000) {
      rmSync(file, { force: true });
      nextSeqCache.delete(file);
      return [];
    }
    const raw = readFileSync(file, "utf-8");
    const out: JournalLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseJournalLine(line);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/** Event payloads in order (control lines excluded) — the replay feed. */
export function replayJournalEvents(lines: JournalLine[]): RuntimeEvent[] {
  return lines.flatMap((l) => ("event" in l ? [l.event] : []));
}

/**
 * True when the journal ends mid-turn: non-empty and the last line is
 * neither a `done` event nor an `aborted` stamp. Empty journals are
 * complete (nothing to recover).
 */
export function journalIncomplete(lines: JournalLine[]): boolean {
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  if ("aborted" in last) return false;
  return last.event.type !== "done";
}

/**
 * Stamp a crashed turn as aborted (idempotent: no-op when the journal is
 * already complete). The stamp is a control line, never a `RuntimeEvent` —
 * consumers see the fact without it polluting the event stream.
 */
export function stampJournalAborted(
  sessionId: string,
  opts: { dir?: string; logger?: RuntimeLogger } = {},
): void {
  const log = opts.logger ?? silentLogger;
  try {
    const lines = readJournal(sessionId, opts);
    if (!journalIncomplete(lines)) return;
    const file = journalPath(sessionId, opts.dir);
    const seq = nextSeq(file);
    appendFileSync(file, `${JSON.stringify({ seq, aborted: true })}\n`, "utf-8");
    nextSeqCache.set(file, seq + 1);
  } catch (err) {
    log.warn("journal-stamp-failed", {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Rewrite the file keeping only the newest lines (called on append past cap). */
export function compactJournalFile(file: string, keepLines: number): void {
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= keepLines) return;
  writeFileSync(file, `${lines.slice(-keepLines).join("\n")}\n`, "utf-8");
}

function compactJournalIfNeeded(file: string): void {
  try {
    if (statSync(file).size > MAX_JOURNAL_BYTES) {
      compactJournalFile(file, JOURNAL_COMPACT_KEEP_LINES);
    }
  } catch {
    // Best-effort — compaction must never break the append path.
  }
}
