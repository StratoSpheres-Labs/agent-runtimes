import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import {
  codexDefinition,
  buildCodexArgs,
  resolveCodexLaunch,
  parseCodexDebugModels,
  type CodexBuildArgsOptions,
} from "./definition.js";
import { CodexParser } from "./parser.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";
import { runCommand } from "../../src/discovery/run-command.js";
import type { RuntimeModel } from "../../src/definition/model.js";
import { CodexSession } from "./session.js";

export class CodexRuntime extends DefaultRuntime {
  public constructor() {
    super(codexDefinition);
  }

  public buildArgs(options: CodexBuildArgsOptions = {}): string[] {
    return buildCodexArgs(options);
  }

  public createParser(): CodexParser {
    return new CodexParser();
  }

  public override async models(): Promise<RuntimeModel[]> {
    // `codex debug models` emits JSON — the generic line parser can't read
    // it, so parse here and fall back to the generic path (→ static list).
    const status = await this.detect();
    const executable = status.installed ? status.executable : codexDefinition.executable.command;
    const res = await runCommand({ command: executable, args: ["debug", "models"] });
    if (!res.timedOut && res.code === 0) {
      const parsed = parseCodexDebugModels(res.stdout);
      if (parsed) return parsed;
    }
    return super.models();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId } = options ?? {};
    // Fail fast at session creation (the session itself re-checks per run):
    // the codex CLI has no MCP wiring, so accepting servers here would
    // silently drop them.
    if (mcpServers !== undefined && mcpServers.length > 0) {
      throw new RuntimeSessionError(
        "codex sessions do not support MCP servers: mcpServers was provided but the codex CLI has no MCP wiring",
        { runtime: "codex" },
      );
    }
    const status = await this.detect();
    const executable = status.installed ? status.executable : codexDefinition.executable.command;
    // Shim-only installs (win32 npm .cmd, no native exe) run via host node.
    const launch = resolveCodexLaunch(executable);
    const sid = `codex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new CodexSession({
      id: sid,
      command: launch.command,
      prependArgs: launch.prependArgs,
      env: launch.env,
      cwd,
      model,
      reasoning,
      workspace,
      resumeSessionId,
    });
  }

  public override async auth(): Promise<AuthStatus> {
    const status = await this.detect();
    if (!status.installed) {
      return {
        authenticated: false,
        method: "unknown",
        detail: "codex is not installed — auth status unknown",
      };
    }
    return probeCodexAuth(status.executable);
  }
}

/**
 * Parse `codex login status` (verified on 0.150.1): the logged-in shape is
 * `Logged in using ChatGPT`. The logged-out shape was never observed
 * (logging out is destructive), so anything else degrades to logged-out
 * with method "none" — the first line is never echoed, only fixed
 * remediation text, so no secret can leak through an unexpected shape.
 */
export function parseCodexLoginStatus(stdout: string): AuthStatus {
  const first = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const m = /^logged in\b(.*)$/i.exec(first);
  if (m) {
    const how = (m[1] ?? "").trim().replace(/^using\s+/i, "");
    let method: AuthMethod = "unknown";
    if (/chatgpt|oauth/i.test(how)) method = "oauth";
    else if (/api.?key/i.test(how)) method = "api-key";
    return {
      authenticated: true,
      method,
      identities: how ? [how] : [],
      detail: how ? `logged in using ${how}` : "logged in",
    };
  }
  return {
    authenticated: false,
    method: "none",
    detail: "not logged in — run `codex login` or set OPENAI_API_KEY",
  };
}

/**
 * Run `codex login status` through the shim-aware launch and parse it.
 * `extraArgs` is a test seam (see probeOpencodeAuth).
 */
export async function probeCodexAuth(
  executable: string,
  extraArgs: string[] = [],
): Promise<AuthStatus> {
  // Shim-only installs (win32 npm .cmd) run via host node — same as sessions.
  const launch = resolveCodexLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...extraArgs, "login", "status"],
    env: launch.env,
  });
  if (res.timedOut) {
    return { authenticated: false, method: "unknown", detail: "codex auth probe timed out" };
  }
  if (res.code === null) {
    return {
      authenticated: false,
      method: "unknown",
      detail: "codex auth probe could not start",
    };
  }
  if (res.code !== 0) {
    return {
      authenticated: false,
      method: "unknown",
      detail: `codex auth probe failed (exit ${String(res.code)})`,
    };
  }
  // Verified on 0.150.1: `login status` prints to stderr, not stdout —
  // parse both streams (identities/detail never echo raw text, so no
  // secret can leak through an unexpected shape).
  return parseCodexLoginStatus(`${res.stdout}\n${res.stderr}`);
}
