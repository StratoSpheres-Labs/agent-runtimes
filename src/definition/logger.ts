/**
 * RuntimeLogger — injected diagnostics sink (AGENTS.md §9).
 * The library is silent by default (`silentLogger`): lifecycle notes
 * (spawn/kill/timeout), transport diagnostics (stderr drain, overflow),
 * and best-effort-cache warnings (session-store, journal) go here instead
 * of `console.log` (forbidden in runtime code) or silent swallows.
 * The embedding app (BFF/daemon) injects its own sink via
 * `CreateSessionOptions.logger` — that is the upper layer's observability
 * hook; nothing in the library assumes its presence.
 */
export interface RuntimeLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Default sink: drops everything. The library never logs without opt-in. */
function drop(..._args: unknown[]): void {
  // Intentionally silent — the default sink. The `_args` rest keeps the
  // signature honest (callers pass through) without tripping unused-vars.
}

export const silentLogger: RuntimeLogger = {
  debug: drop,
  info: drop,
  warn: drop,
  error: drop,
};

/**
 * Console sink for development (`createSession({ logger: consoleLogger() })`).
 * Production embeds its own structured sink instead.
 */
export function consoleLogger(prefix = "agent-runtimes"): RuntimeLogger {
  return {
    debug: (...args: unknown[]): void => {
      console.debug(`[${prefix}]`, ...args);
    },
    info: (...args: unknown[]): void => {
      console.info(`[${prefix}]`, ...args);
    },
    warn: (...args: unknown[]): void => {
      console.warn(`[${prefix}]`, ...args);
    },
    error: (...args: unknown[]): void => {
      console.error(`[${prefix}]`, ...args);
    },
  };
}
