/**
 * Agent-agnostic auth status — Phase 22.
 * Answers "can this runtime actually run?" without assuming any single auth
 * model (CLI login, OAuth, env var, API key, credential file). Detection
 * only: this library never performs interactive login.
 *
 * Secrecy contract: `identities`/`detail` must NEVER contain secret values
 * (keys, tokens) — provider labels and counts only. Probes read config
 * presence and status subcommands, never secret contents. The one exception
 * is `stderrTail` on *failed* probes: a single capped error line from a
 * status subcommand (`auth list`, `login status`), which by verified shape
 * never prints key material — and the cap bounds any surprise to 200 chars.
 */
export type AuthMethod = "oauth" | "api-key" | "none" | "unknown";

/**
 * Last non-empty stderr line of a failed probe, capped at 200 chars.
 * Carries the CLI's own reason (`command not found`, `permission denied`,
 * login-expired hints) into failure details. Returns null when there is
 * nothing to show. Single capped line only — never a full stream dump —
 * so secret-adjacent output cannot ride along in bulk.
 */
export function stderrTail(stderr: string, maxChars = 200): string | null {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (!line) return null;
  return line.length > maxChars ? line.slice(0, maxChars) : line;
}

/**
 * Append a stderr tail to a failure detail (`base: tail`), or return base
 * unchanged when there is none.
 */
export function withStderrTail(base: string, stderr: string): string {
  const tail = stderrTail(stderr);
  return tail === null ? base : `${base}: ${tail}`;
}

export interface AuthStatus {
  authenticated: boolean;
  /**
   * "none" ONLY when the CLI positively reports logged-out/empty;
   * "unknown" when the probe itself failed (timeout, spawn error,
   * unparseable output) — callers must not read that as logged-out.
   */
  method: AuthMethod;
  /** Non-secret identities (provider labels, login kind). Never secrets. */
  identities?: string[];
  /** Human-readable, secret-free summary (remediation when logged out). */
  detail: string;
}
