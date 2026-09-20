import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import { claudeDefinition, buildClaudeArgs, type ClaudeBuildArgsOptions } from "./definition.js";
import { ClaudeParser } from "./parser.js";
import { ClaudeSession } from "./session.js";
import { runCommand } from "../../src/discovery/run-command.js";
import { resolveLaunch } from "../../src/discovery/launch.js";
import { assertKnownModel } from "../../src/discovery/models.js";
import { discoverMcp } from "../../src/discovery/mcp.js";
import { discoverSkills, type SkillRoot } from "../../src/discovery/skills.js";
import type { RuntimeSkill } from "../../src/definition/skill.js";
import type { RuntimePlugin } from "../../src/definition/plugin.js";
import type { McpServerInfo } from "../../src/definition/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";
import { withStderrTail } from "../../src/definition/auth.js";

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
  const launch = resolveLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...extraArgs, "auth", "status"],
    env: launch.env,
  });
  if (res.timedOut) {
    return {
      authenticated: false,
      method: "unknown",
      detail: withStderrTail("claude auth probe timed out", res.stderr),
    };
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
      detail: withStderrTail(`claude auth probe failed (exit ${String(res.code)})`, res.stderr),
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
    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId, onPermissionRequest } =
      options ?? {};
    // Static fallback is the only catalog claude has — validation is free
    // (no probe) once models() primed it, fail-open otherwise.
    await assertKnownModel(
      claudeDefinition.identity.id,
      model,
      claudeDefinition.models?.fallbackModels ?? [],
      () => this.models(),
    );
    const status = await this.detect();
    const command = status.installed ? status.executable : claudeDefinition.executable.command;
    const sid = `claude_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new ClaudeSession({
      id: sid,
      command,
      cwd,
      model,
      reasoning,
      mcpServers,
      workspace,
      resumeSessionId,
      onPermissionRequest,
    });
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

  public override async mcp(): Promise<McpServerInfo[]> {
    const status = await this.detect();
    if (!status.installed) return [];
    return discoverMcp(status.executable, ["mcp", "list"]);
  }

  public override async plugins(): Promise<RuntimePlugin[]> {
    const status = await this.detect();
    if (!status.installed) {
      // No binary — installed_plugins.json may still exist (CLI removed).
      return readClaudePluginsFile() ?? [];
    }
    return probeClaudePlugins(status.executable);
  }

  /**
   * Read-only skill metadata (never the body). File scan only — the claude
   * CLI has no `skills` list subcommand, so there is nothing to probe.
   * `cwd` opts into the project root; omitted = global root only.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public override async skills(options?: { cwd?: string }): Promise<RuntimeSkill[]> {
    return discoverSkills(claudeSkillSearchDirs({ cwd: options?.cwd }));
  }
}

/**
 * Parse `claude plugin list --json` (verified on 2.1.187): an array of
 * `{id, version, scope, enabled, installPath, ...}`. `installPath` is
 * deliberately dropped — machine layout, not plugin metadata.
 * Unparseable output returns null (caller falls back to the file).
 */
export function parseClaudePluginList(stdout: string): RuntimePlugin[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: RuntimePlugin[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const rawId = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    if (!rawId || rawId.length > 200) continue;
    const scope = typeof rec["scope"] === "string" ? rec["scope"] : "";
    const version = typeof rec["version"] === "string" ? rec["version"] : undefined;
    const enabled = typeof rec["enabled"] === "boolean" ? rec["enabled"] : undefined;
    const projectPath =
      typeof rec["projectPath"] === "string" && rec["projectPath"].length > 0
        ? rec["projectPath"]
        : undefined;
    out.push({
      id: rawId,
      source: scope === "project" ? "project" : "global",
      kind: "marketplace",
      ...(version !== undefined ? { version } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(projectPath !== undefined ? { projectPath } : {}),
    });
  }
  return out;
}

/**
 * Read `installed_plugins.json` directly (`~/.claude/plugins/`).
 * Shape: `{plugins: {"id": [{scope, version, ...}]}}`. Only ids + scope +
 * version are surfaced — install paths and SHAs never leave the file.
 * Returns null when the file is missing/unparseable (not an error).
 */
export function readClaudePluginsFile(opts: { homeDir?: string } = {}): RuntimePlugin[] | null {
  const file = join(opts.homeDir ?? homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const table = (parsed as Record<string, unknown>)["plugins"];
  if (typeof table !== "object" || table === null || Array.isArray(table)) return null;
  const out: RuntimePlugin[] = [];
  for (const [id, installs] of Object.entries(table as Record<string, unknown>)) {
    if (!id || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (typeof install !== "object" || install === null) continue;
      const rec = install as Record<string, unknown>;
      const scope = typeof rec["scope"] === "string" ? rec["scope"] : "";
      const version = typeof rec["version"] === "string" ? rec["version"] : undefined;
      const projectPath =
        typeof rec["projectPath"] === "string" && rec["projectPath"].length > 0
          ? rec["projectPath"]
          : undefined;
      out.push({
        id,
        source: scope === "project" ? "project" : "global",
        kind: "marketplace",
        ...(version !== undefined ? { version } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
      });
    }
  }
  return out;
}

/**
 * Run `claude plugin list --json` and parse it. `extraArgs` is a test seam:
 * `probeClaudePlugins(process.execPath, ["-e", script])` runs canned output
 * through the full spawn path without touching the real CLI.
 * When the CLI probe itself fails, falls back to `installed_plugins.json`.
 */
export async function probeClaudePlugins(
  executable: string,
  extraArgs: string[] = [],
  opts: { homeDir?: string } = {},
): Promise<RuntimePlugin[]> {
  const launch = resolveLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...extraArgs, "plugin", "list", "--json"],
    env: launch.env,
  });
  if (!res.timedOut && res.code === 0) {
    const parsed = parseClaudePluginList(res.stdout);
    if (parsed !== null) return parsed;
  }
  return readClaudePluginsFile(opts) ?? [];
}

/**
 * Claude skill roots: global `~/.claude/skills` (verified live) plus the
 * project `<cwd>/.claude/skills` when a cwd is given. Plugin-bundled
 * skills (`~/.claude/plugins/...`) are deliberately excluded — deeper tree,
 * separate feature. Pure (no fs) — safe to unit test.
 */
export function claudeSkillSearchDirs(
  options: { homeDir?: string; cwd?: string } = {},
): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const home = options.homeDir ?? homedir();
  if (home) roots.push({ dir: join(home, ".claude", "skills"), source: "global" });
  if (options.cwd)
    roots.push({ dir: resolve(options.cwd, ".claude", "skills"), source: "project" });
  return roots;
}
