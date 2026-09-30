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
 * tool output. Entries are parsed on demand, desensitized by default (see
 * `redactSecrets` — opt out per call with `includeRawInputs`), and never
 * persisted by this library — callers must not log or forward them
 * blindly. Long texts are truncated (see `MAX_TRANSCRIPT_TEXT`).
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
  /**
   * Desensitization marker, always explicit: `true` when the text passed
   * through `redactSecrets` (the default), `false` only under an explicit
   * `includeRawInputs` opt-out.
   */
  redacted?: boolean;
}

export interface HistoryOptions {
  /** Newest N entries (default: all). Applied after `since` filtering. */
  limit?: number;
  /** Only entries at or after this millisecond epoch. */
  since?: number;
  /**
   * Return raw entry text without desensitization (default false).
   * The default path marks every entry `redacted: true`; opt out only for
   * trusted first-party consumers — raw text may carry pasted secrets.
   */
  includeRawInputs?: boolean;
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

/**
 * Credential-shaped substrings, replaced wholesale with `[redacted]`.
 * Deliberately narrow (fail-closed only on near-certain shapes — a missed
 * secret is worse than an over-masked word, but prose must survive):
 * vendor key prefixes with length floors, `k=v` pairs for secret nouns
 * (the `[:=]` anchor keeps "token budget" style prose intact), and bearer
 * tokens. Pure, testable.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9-_]{8,}/g,
  /sk-proj-[A-Za-z0-9-_]{8,}/g,
  /sk-live-[A-Za-z0-9-_]{8,}/g,
  /sk-[A-Za-z0-9-_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /(api[_-]?key|client[_-]?secret|access[_-]?key|passwd|password|secret|token)\s*[:=]\s*['"]?[^\s'",}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g,
];

/** Mask credential-shaped substrings. Pure, testable. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/**
 * Desensitize folded entries for display/sync. Default marks every entry
 * `redacted: true` with masked text; `includeRawInputs` returns the text
 * untouched and marks `redacted: false`. The flag is always explicit so a
 * consumer can grep its own handling. Pure, testable.
 */
export function redactTranscriptEntries(
  entries: TranscriptEntry[],
  includeRawInputs = false,
): TranscriptEntry[] {
  return entries.map((e) => ({
    ...e,
    text: includeRawInputs ? e.text : redactSecrets(e.text),
    redacted: !includeRawInputs,
  }));
}
