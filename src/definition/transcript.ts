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
  /**
   * Sub-agent runs spawned by THIS tool call, when the caller asked for them
   * via `includeSubAgents` and the runtime records them (see
   * `RuntimeCapabilities.subAgents`). Only ever set on a `tool` entry.
   *
   * Absent — not `[]` — when there are none, when they were not requested, or
   * when the runtime has no such capability. An empty array would claim "we
   * looked and there were none", which is a different statement.
   *
   * A sub-agent the CLI recorded but that could not be tied back to a spawning
   * tool call is omitted rather than guessed onto a plausible one: this is a
   * read-only projection, and a wrong parent is a lie the caller cannot detect.
   */
  subAgents?: readonly SubAgentTurn[];
}

/**
 * One nested agent run — a sub-agent the parent session dispatched.
 *
 * Deliberately a *recording of what the CLI did*, not a claim about causality:
 * `entries` is that sub-agent's own transcript, folded by the same rules (so
 * redaction, truncation, and reasoning/image dropping apply unchanged, at every
 * depth).
 */
export interface SubAgentTurn {
  /** Native, opaque id of the nested run (a child session id, an agent id). */
  readonly id: string;
  /** The sub-agent's own name when the CLI recorded one (e.g. `"explore"`). */
  readonly name?: string;
  /** One-line label the CLI recorded for the run, when it has one. */
  readonly title?: string;
  /** The nested transcript, in the same order the CLI recorded it. */
  readonly entries: readonly TranscriptEntry[];
  /** Millisecond epoch when the CLI recorded the run (absent when unknown). */
  readonly timestamp?: number;
  /** `0` for a direct child of the session that was read. */
  readonly depth: number;
}

/** How deep `includeSubAgents` expands when the caller names no limit. */
export const DEFAULT_SUB_AGENT_MAX_DEPTH = 2;

/**
 * Clamp a caller-supplied depth into a usable level count.
 *
 * Shared so every adapter agrees on what `-1`, `NaN`, and a missing value mean —
 * an adapter that interpreted them differently would make "depth 1" a different
 * amount of transcript per runtime, which is exactly the kind of drift this
 * project treats as a bug.
 */
export function resolveMaxDepth(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_SUB_AGENT_MAX_DEPTH;
  }
  return Math.max(0, Math.trunc(requested));
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
  /**
   * Nest sub-agent transcripts under the tool call that dispatched them
   * (default **false**).
   *
   * Off by default because it multiplies the returned text: one turn can pull
   * in a dozen full sub-agent transcripts, all subject to the same pasted-secret
   * exposure as the parent. Off is also the honest default for a runtime whose
   * `subAgents` capability is false — such a runtime returns nothing either way.
   *
   * Has no effect on a runtime without the capability; it never throws.
   */
  includeSubAgents?: boolean;
  /**
   * How many nesting levels to expand (default {@link DEFAULT_SUB_AGENT_MAX_DEPTH}).
   * `0` keeps the children but does not expand their own children; `1` is direct
   * children only. Sub-agents can dispatch sub-agents, so this is a real bound,
   * not a formality — an unbounded walk over a transcript tree is how a history
   * call turns into a disk scan.
   */
  maxDepth?: number;
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
  const sliced =
    options.limit === undefined || options.limit < 0
      ? filtered
      : filtered.slice(Math.max(0, filtered.length - options.limit));
  // `since`/`limit` select top-level TURNS. Sub-agent content is deliberately
  // not filtered or counted: it belongs to the turn that dispatched it, so
  // half-filtering it would leave a tool entry showing a child transcript with
  // holes in it and no marker saying so.
  return sliced;
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
  entries: readonly TranscriptEntry[],
  includeRawInputs = false,
): TranscriptEntry[] {
  return entries.map((e) => ({
    ...e,
    text: includeRawInputs ? e.text : redactSecrets(e.text),
    redacted: !includeRawInputs,
    // Recurse. A flat map would leave every sub-agent transcript — often far
    // more text than the parent turn, and often raw tool output — completely
    // unredacted while the parent entry carries `redacted: true`. That is the
    // worst possible shape for this helper: a caller checking the marker would
    // conclude the whole tree had been through redaction.
    ...(e.subAgents !== undefined
      ? {
          subAgents: e.subAgents.map((sub) => ({
            ...sub,
            entries: redactTranscriptEntries(sub.entries, includeRawInputs),
          })),
        }
      : {}),
  }));
}
