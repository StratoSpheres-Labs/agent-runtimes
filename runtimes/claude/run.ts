import { DefaultRun } from "../../src/core/run.js";

/**
 * Claude AskUserQuestion answer envelope (verified live on 2.1.187):
 * a `user` transcript envelope carrying the choice as `tool_result`
 * content. Pure builder — unit-testable without spawning.
 */
export function buildClaudePermissionAnswer(id: string, optionId: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: optionId }],
      },
    }) + "\n"
  );
}

/**
 * Claude interactive run — DefaultRun plus the native permission-answer
 * envelope. The shape lives here (adapter side of Rule 6), never in core.
 */
export class ClaudeRun extends DefaultRun {
  // Implements the AgentRun.respondToPermission slot (absent on the base).
  public async respondToPermission(id: string, optionId: string): Promise<void> {
    await this.writeStdin(buildClaudePermissionAnswer(id, optionId));
  }

  // NOTE: no send() override — verified live (3 runs, 2.1.278) that print
  // mode consumes only the initial stdin prompt: follow-up envelopes are
  // accepted by the pipe but never processed (exact-30-word control +
  // text-only control both ignored). Interactive answers keep working via
  // respondToPermission (the turn explicitly pauses for tool_result —
  // a different mechanism). The base rejects send() loudly.
}
