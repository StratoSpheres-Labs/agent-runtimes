import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import {
  opencodeDefinition,
  buildOpencodeArgs,
  type OpencodeBuildArgsOptions,
} from "./definition.js";
import { OpencodeParser } from "./parser.js";
import { OpencodeSession } from "./session.js";
import { runCommand } from "../../src/discovery/run-command.js";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";

// Matches ANSI color escapes in `opencode auth list` (built from char code —
// a literal \x1b in the pattern would trip no-control-regex).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Parse `opencode auth list` (verified on 1.18.27): a credential tree with
 * `●  <name> <kind>` lines plus a `<n> credentials` footer. No JSON flag
 * exists, so parse defensively — any shape change degrades to unknown,
 * never to a false logged-out.
 */
export function parseOpencodeAuthList(stdout: string): AuthStatus {
  const text = stdout.replace(ANSI_ESCAPE, "");
  const identities: string[] = [];
  let sawOauth = false;
  let sawApiKey = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("●")) continue;
    const rest = line.slice(1).trim().split(/\s+/);
    const kind = rest.pop() ?? "";
    const name = rest.join(" ");
    if (!name) continue;
    identities.push(name);
    if (/oauth/i.test(kind)) sawOauth = true;
    else if (/api/i.test(kind)) sawApiKey = true;
  }
  const countMatch = /(\d+)\s+credentials?/i.exec(text);
  const count = countMatch?.[1] === undefined ? identities.length : Number(countMatch[1]);
  if (count > 0 || identities.length > 0) {
    let method: AuthMethod = "unknown";
    if (sawOauth) method = "oauth";
    else if (sawApiKey) method = "api-key";
    const shown = identities.slice(0, 5).join(", ");
    return {
      authenticated: true,
      method,
      identities,
      detail: `${String(count)} opencode credential(s)${shown ? `: ${shown}` : ""}`,
    };
  }
  return {
    authenticated: false,
    method: "none",
    detail: "no opencode credentials — run `opencode auth login`",
  };
}

/**
 * Run `opencode auth list` and parse it. `extraArgs` is a test seam:
 * `probeOpencodeAuth(process.execPath, ["-e", script])` runs canned output
 * through the full spawn path without touching the real CLI.
 */
export async function probeOpencodeAuth(
  executable: string,
  extraArgs: string[] = [],
): Promise<AuthStatus> {
  const res = await runCommand({ command: executable, args: [...extraArgs, "auth", "list"] });
  if (res.timedOut) {
    return { authenticated: false, method: "unknown", detail: "opencode auth probe timed out" };
  }
  if (res.code === null) {
    return {
      authenticated: false,
      method: "unknown",
      detail: "opencode auth probe could not start",
    };
  }
  if (res.code !== 0) {
    return {
      authenticated: false,
      method: "unknown",
      detail: `opencode auth probe failed (exit ${String(res.code)})`,
    };
  }
  return parseOpencodeAuthList(res.stdout);
}

/**
 * OpenCode runtime adapter — Phase 9 + P1 wiring
 * Wraps DefaultRuntime with opencode-specific arg building, parser,
 * and a Session factory that actually spawns `opencode` (not the Node echo stub).
 */
export class OpencodeRuntime extends DefaultRuntime {
  public constructor() {
    super(opencodeDefinition);
  }

  public buildArgs(options: OpencodeBuildArgsOptions = {}): string[] {
    return buildOpencodeArgs(options);
  }

  public createParser(): OpencodeParser {
    return new OpencodeParser();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId } = options ?? {};
    const status = await this.detect();
    const command = status.installed ? status.executable : opencodeDefinition.executable.command;
    const sid = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new OpencodeSession({ id: sid, command, cwd, model, reasoning, mcpServers, workspace, resumeSessionId });
  }

  public override async auth(): Promise<AuthStatus> {
    const status = await this.detect();
    if (!status.installed) {
      return {
        authenticated: false,
        method: "unknown",
        detail: "opencode is not installed — auth status unknown",
      };
    }
    return probeOpencodeAuth(status.executable);
  }
}
