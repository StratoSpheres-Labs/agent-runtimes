import { silentLogger, type RuntimeLogger } from "../definition/logger.js";
import type { AgentSession } from "./session.js";

/**
 * Host-level session registry for graceful shutdown. Sessions self-register
 * on construction (see `DefaultSession` + adapters); references are weak,
 * so tracking never leaks a session the owner already dropped — `shutdown`
 * simply closes whatever is still alive. One line for BFF SIGTERM handlers;
 * per-run `close()` stays the normal path.
 */
const live = new Set<WeakRef<AgentSession>>();

/** Called by session constructors. Idempotent per object (Set semantics). */
export function trackSession(session: AgentSession): void {
  live.add(new WeakRef(session));
}

/**
 * Close every tracked session still alive, each in its own try/catch so
 * one bad teardown never blocks the rest. Clears the set afterwards.
 */
export async function shutdownAllSessions(log: RuntimeLogger = silentLogger): Promise<void> {
  const sessions: AgentSession[] = [];
  for (const ref of live) {
    const session = ref.deref();
    if (session) sessions.push(session);
  }
  live.clear();
  for (const session of sessions) {
    try {
      await session.close();
    } catch (err) {
      log.warn("shutdown-close-failed", {
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
