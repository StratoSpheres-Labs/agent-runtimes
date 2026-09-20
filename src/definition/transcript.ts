/**
 * Conversation history — compact, read-only, agent-agnostic.
 *
 * `history()` reads the CLI's own transcript store (never a second copy
 * written by this library) and folds it into one entry per turn: user text,
 * assistant text, and one compressed line per tool call. Thinking/reasoning
 * parts are dropped (they already have `reasoning_delta` on the wire);
 * images are skipped (binary has no place in a text summary).
 *
 * Privacy: transcripts may contain secrets pasted by the user or echoed in
 * tool output. Entries are parsed on demand and never persisted by this
 * library — callers must not log or forward them blindly. Long texts are
 * truncated (see `MAX_TRANSCRIPT_TEXT`).
 */

/** One folded turn of conversation. */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  /** Compact plain text; tool entries read `name: one-line result`. */
  text: string;
  /** Tool name when `role` is `"tool"`. */
  toolName?: string;
  /** Millisecond epoch when the CLI recorded it (absent when unknown). */
  timestamp?: number;
}

export interface HistoryOptions {
  /** Newest N entries (default: all). Applied after `since` filtering. */
  limit?: number;
  /** Only entries at or after this millisecond epoch. */
  since?: number;
}

/** Per-entry text cap — tool outputs can be megabytes. */
export const MAX_TRANSCRIPT_TEXT = 2000;

/** Truncate display text with an ellipsis marker (pure, testable). */
export function truncateTranscriptText(text: string, max: number = MAX_TRANSCRIPT_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Normalize a CLI timestamp to millisecond epoch. CLIs mix seconds and
 * milliseconds across versions; values outside both ranges yield
 * `undefined` rather than a date in 1970 or 50000. Pure, testable.
 */
export function toMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value >= 1e12 && value < 1e15) return Math.floor(value);
  if (value >= 1e9 && value < 1e12) return Math.floor(value * 1000);
  return undefined;
}

/** Apply `since` filtering then `limit` (newest N). Pure, testable. */
export function selectHistory(
  entries: TranscriptEntry[],
  options: HistoryOptions = {},
): TranscriptEntry[] {
  const since = options.since;
  const filtered =
    since === undefined
      ? entries
      : entries.filter((e) => e.timestamp !== undefined && e.timestamp >= since);
  if (options.limit === undefined || options.limit < 0) return filtered;
  return filtered.slice(Math.max(0, filtered.length - options.limit));
}
