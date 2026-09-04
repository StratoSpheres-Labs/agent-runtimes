/**
 * Agent-agnostic auth status — Phase 22.
 * Answers "can this runtime actually run?" without assuming any single auth
 * model (CLI login, OAuth, env var, API key, credential file). Detection
 * only: this library never performs interactive login.
 *
 * Secrecy contract: `identities`/`detail` must NEVER contain secret values
 * (keys, tokens) — provider labels and counts only. Probes read config
 * presence and status subcommands, never secret contents.
 */
export type AuthMethod = "oauth" | "api-key" | "none" | "unknown";

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
