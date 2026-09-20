import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import {
  codexDefinition,
  buildCodexArgs,
  resolveCodexLaunch,
  checkCodexModelSupport,
  parseCodexDebugModels,
  parseCodexMcpList,
  readCodexPluginsFile,
  type CodexBuildArgsOptions,
} from "./definition.js";
import { CodexParser } from "./parser.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";
import { withStderrTail } from "../../src/definition/auth.js";
import { runCommand } from "../../src/discovery/run-command.js";
import { assertKnownModel, rememberLiveModels } from "../../src/discovery/models.js";
import { discoverSkills, type SkillRoot } from "../../src/discovery/skills.js";
import type { RuntimeSkill } from "../../src/definition/skill.js";
import type { RuntimeModel } from "../../src/definition/model.js";
import type { McpServerInfo } from "../../src/definition/mcp.js";
import type { RuntimePlugin } from "../../src/definition/plugin.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
    // it, so parse here. Shim-aware launch: a win32 npm `.cmd` fails with
    // EINVAL when spawned directly (same trap as version/auth probes).
    // On any failure return [] ("unknown") — never a stale static list.
    const status = await this.detect();
    const executable = status.installed ? status.executable : codexDefinition.executable.command;
    const launch = resolveCodexLaunch(executable);
    const listCommand = codexDefinition.models?.listCommand ?? ["debug", "models"];
    const res = await runCommand({
      command: launch.command,
      args: [...launch.prependArgs, ...listCommand],
      env: launch.env,
    });
    if (!res.timedOut && res.code === 0) {
      const parsed = parseCodexDebugModels(res.stdout);
      if (parsed) {
        rememberLiveModels(codexDefinition.identity.id, parsed);
        return parsed;
      }
    }
    return [];
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId } = options ?? {};
    // Unknown-model gate first (no I/O when unprimed), then the MCP
    // fail-fast, then detect + the CLI-floor preflight below.
    await assertKnownModel(
      codexDefinition.identity.id,
      model,
      codexDefinition.models?.fallbackModels ?? [],
      () => this.models(),
    );
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
    // Model↔CLI preflight (fail fast like the MCP check above): a proven
    // floor violation would otherwise die mid-run with a cryptic CLI error.
    const support = checkCodexModelSupport(
      model,
      status.installed ? (status.version ?? null) : null,
    );
    if (!support.supported) {
      throw new RuntimeSessionError(
        `codex model ${support.model} requires CLI >= ${support.required} — upgrade codex`,
        { runtime: "codex" },
      );
    }
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

  public override async mcp(): Promise<McpServerInfo[]> {
    // Discovery via `codex mcp list` (shim-aware launch like the other
    // probes). Session-side injection is still unsupported — createSession
    // rejects mcpServers loudly instead of silently dropping them.
    const status = await this.detect();
    if (!status.installed) return [];
    const launch = resolveCodexLaunch(status.executable);
    const res = await runCommand({
      command: launch.command,
      args: [...launch.prependArgs, "mcp", "list"],
      env: launch.env,
    });
    if (res.timedOut || res.code !== 0) return [];
    return parseCodexMcpList(`${res.stdout}\n${res.stderr}`);
  }

  public override async plugins(): Promise<RuntimePlugin[]> {
    const status = await this.detect();
    if (!status.installed) {
      // No binary — config.toml may still declare plugins (CLI removed).
      return readCodexPluginsFile() ?? [];
    }
    return probeCodexPlugins(status.executable);
  }

  /**
   * Read-only skill metadata (never the body). File scan only — the codex
   * CLI has no `skills` list subcommand, so there is nothing to probe.
   * `cwd` opts into the project root; omitted = global root only.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public override async skills(options?: { cwd?: string }): Promise<RuntimeSkill[]> {
    return discoverSkills(codexSkillSearchDirs({ cwd: options?.cwd }));
  }
}

/**
 * Parse `codex plugin list --json` (verified on 0.150.1): without
 * `--available` it reports `{installed: [{pluginId, name,
 * marketplaceName, version, installed, enabled, ...}]}`. Paths are
 * deliberately dropped — machine layout, not plugin metadata.
 * Unparseable output returns null (caller falls back to config.toml).
 */
export function parseCodexPluginList(stdout: string): RuntimePlugin[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["installed"]
      : null;
  if (!Array.isArray(list)) return null;
  const out: RuntimePlugin[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const pluginId = typeof rec["pluginId"] === "string" ? rec["pluginId"].trim() : "";
    // Observed id shape is `name@marketplace`; synthesize it when only the
    // parts are present so a bare `name` never leaks out ambiguous.
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
    const marketplace =
      typeof rec["marketplaceName"] === "string" ? rec["marketplaceName"].trim() : "";
    const id = pluginId || (name && marketplace ? `${name}@${marketplace}` : name);
    if (!id || id.length > 200) continue;
    const version = typeof rec["version"] === "string" ? rec["version"] : undefined;
    const enabled = typeof rec["enabled"] === "boolean" ? rec["enabled"] : undefined;
    out.push({
      id,
      source: "global",
      kind: "marketplace",
      ...(version !== undefined ? { version } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }
  return out;
}

/**
 * Run `codex plugin list --json` and parse it. `extraArgs` is a test seam:
 * `probeCodexPlugins(process.execPath, ["-e", script])` runs canned output
 * through the full spawn path without touching the real CLI.
 * When the CLI probe itself fails, falls back to config.toml.
 */
export async function probeCodexPlugins(
  executable: string,
  extraArgs: string[] = [],
  opts: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RuntimePlugin[]> {
  const launch = resolveCodexLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...extraArgs, "plugin", "list", "--json"],
    env: launch.env,
  });
  if (!res.timedOut && res.code === 0) {
    const parsed = parseCodexPluginList(res.stdout);
    if (parsed !== null) return parsed;
  }
  return readCodexPluginsFile(opts) ?? [];
}

/**
 * Codex skill roots: user `<home>/skills` first (wins on name clashes),
 * then built-in `<home>/skills/.system` (verified live — carries the
 * `.codex-system-skills.marker`), then project `<cwd>/.codex/skills` when
 * a cwd is given. Home honors `$CODEX_HOME` like `resolveCodexConfigPath`.
 * Plugin-bundled skills are deliberately excluded — separate feature.
 * Pure (no fs) — safe to unit test.
 */
export function codexSkillSearchDirs(
  options: { homeDir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SkillRoot[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const roots: SkillRoot[] = [
    { dir: join(home, "skills"), source: "global" },
    { dir: join(home, "skills", ".system"), source: "global" },
  ];
  if (options.cwd) roots.push({ dir: resolve(options.cwd, ".codex", "skills"), source: "project" });
  return roots;
}

/**
 * Parse `codex login status` (verified on 0.150.1): the logged-in shape is
 * `Logged in using ChatGPT`. The logged-out shape was never observed
 * (logging out is destructive), so anything else degrades to logged-out
 * with method "none" — the first line is never echoed, only fixed
 * remediation text, so no secret can leak through an unexpected shape.
 */
export function parseCodexLoginStatus(stdout: string): AuthStatus {
  const first =
    stdout
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
    return {
      authenticated: false,
      method: "unknown",
      detail: withStderrTail("codex auth probe timed out", res.stderr),
    };
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
      detail: withStderrTail(`codex auth probe failed (exit ${String(res.code)})`, res.stderr),
    };
  }
  // Verified on 0.150.1: `login status` prints to stderr, not stdout —
  // parse both streams (identities/detail never echo raw text, so no
  // secret can leak through an unexpected shape).
  return parseCodexLoginStatus(`${res.stdout}\n${res.stderr}`);
}
