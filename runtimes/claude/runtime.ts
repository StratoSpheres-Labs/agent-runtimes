import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import { claudeDefinition, buildClaudeArgs, type ClaudeBuildArgsOptions } from "./definition.js";
import { ClaudeParser } from "./parser.js";
import { ClaudeSession } from "./session.js";
import { runCommand } from "../../src/discovery/run-command.js";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";

/**
 * Parse `claude auth status` JSON (verified on 2.1.187):
 * `{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}`.
 * File-presence probing is wrong here — subscription OAuth lives in the OS
 * keychain, not `~/.claude/.credentials.json`. Unparseable output degrades
 * to unknown, never to a false logged-out.
 */
export function parseClaudeAuthStatus(stdout: string): AuthStatus {
  let data: unknown;
  try {
    data = JSON.parse(stdout) as unknown;
  } catch {
    return {
      authenticated: false,
      method: "unknown",
      detail: "claude auth probe returned unparseable output",
    };
  }
  if (typeof data !== "object" || data === null) {
    return {
      authenticated: false,
      method: "unknown",
      detail: "claude auth probe returned unexpected output",
    };
  }
  const rec = data as Record<string, unknown>;
  if (rec["loggedIn"] === true) {
    const raw = typeof rec["authMethod"] === "string" ? rec["authMethod"] : "";
    let method: AuthMethod = "unknown";
    if (/oauth/i.test(raw)) method = "oauth";
    else if (/api.?key/i.test(raw)) method = "api-key";
    const provider = typeof rec["apiProvider"] === "string" ? rec["apiProvider"] : "";
    return {
      authenticated: true,
      method,
      identities: provider ? [provider] : [],
      detail: `logged in via ${raw || "unknown method"}`,
    };
  }
  return {
    authenticated: false,
    method: "none",
    detail: "not logged in — run `claude auth login` or set ANTHROPIC_API_KEY",
  };
}

/**
 * Run `claude auth status` and parse it. `extraArgs` is a test seam (see
 * probeOpencodeAuth): canned stdout through the full spawn path.
 */
export async function probeClaudeAuth(
  executable: string,
  extraArgs: string[] = [],
): Promise<AuthStatus> {
  const res = await runCommand({ command: executable, args: [...extraArgs, "auth", "status"] });
  if (res.timedOut) {
    return { authenticated: false, method: "unknown", detail: "claude auth probe timed out" };
  }
  if (res.code === null) {
    return {
      authenticated: false,
      method: "unknown",
      detail: "claude auth probe could not start",
    };
  }
  if (res.code !== 0) {
    return {
      authenticated: false,
      method: "unknown",
      detail: `claude auth probe failed (exit ${String(res.code)})`,
    };
  }
  return parseClaudeAuthStatus(res.stdout);
}

export class ClaudeRuntime extends DefaultRuntime {
  public constructor() {
    super(claudeDefinition);
  }

  public buildArgs(options: ClaudeBuildArgsOptions = {}): string[] {
    return buildClaudeArgs(options);
  }

  public createParser(): ClaudeParser {
    return new ClaudeParser();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId, onPermissionRequest } = options ?? {};
    const status = await this.detect();
    const command = status.installed ? status.executable : claudeDefinition.executable.command;
    const sid = `claude_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new ClaudeSession({ id: sid, command, cwd, model, reasoning, mcpServers, workspace, resumeSessionId, onPermissionRequest });
  }

  public override async auth(): Promise<AuthStatus> {
    const status = await this.detect();
    if (!status.installed) {
      return {
        authenticated: false,
        method: "unknown",
        detail: "claude is not installed — auth status unknown",
      };
    }
    return probeClaudeAuth(status.executable);
  }
}
