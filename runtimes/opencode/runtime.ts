import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import {
  opencodeDefinition,
  buildOpencodeArgs,
  parseOpenCodeModels,
  mergeOpencodeModelLists,
  rememberOpencodeModels,
  type OpencodeBuildArgsOptions,
} from "./definition.js";
import { OpencodeParser } from "./parser.js";
import { OpencodeSession } from "./session.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/discovery/run-command.js";
import { resolveLaunch } from "../../src/discovery/launch.js";
import {
  assertKnownModel,
  discoverModels,
  rememberLiveModels,
} from "../../src/discovery/models.js";
import { discoverMcp } from "../../src/discovery/mcp.js";
import { discoverSkills, skillSearchDirs } from "../../src/discovery/skills.js";
import {
  discoverPlugins,
  pluginConfigFiles,
  pluginSearchDirs,
} from "../../src/discovery/plugins.js";
import type { RuntimeSkill } from "../../src/definition/skill.js";
import type { RuntimePlugin } from "../../src/definition/plugin.js";
import type { McpServerInfo } from "../../src/definition/mcp.js";
import type { RuntimeModel } from "../../src/definition/model.js";
import type { AuthMethod, AuthStatus } from "../../src/definition/auth.js";
import { withStderrTail } from "../../src/definition/auth.js";

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
 * Read `auth.json` directly (`~/.local/share/opencode/auth.json`,
 * `XDG_DATA_HOME` respected). Shape: `{providerId: {type, key}}`.
 * Only provider ids + types are surfaced — key material is never read
 * into strings that could leak into logs/details.
 * Returns null when the file is missing/unparseable (not an error).
 */
export function readOpencodeAuthFile(
  opts: { homeDir?: string; dataDir?: string } = {},
): AuthStatus | null {
  const dataDir =
    opts.dataDir ??
    process.env["XDG_DATA_HOME"] ??
    join(opts.homeDir ?? homedir(), ".local", "share");
  const file = join(dataDir, "opencode", "auth.json");
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ids: string[] = [];
  let sawOauth = false;
  let sawApiKey = false;
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    ids.push(id);
    const type = (entry as Record<string, unknown>)["type"];
    if (typeof type === "string") {
      if (/oauth/i.test(type)) sawOauth = true;
      else if (/api/i.test(type)) sawApiKey = true;
    }
  }
  if (ids.length === 0) return null;
  let method: AuthMethod = "unknown";
  if (sawOauth) method = "oauth";
  else if (sawApiKey) method = "api-key";
  const shown = ids.slice(0, 5).join(", ");
  return {
    authenticated: true,
    method,
    identities: ids,
    detail: `${String(ids.length)} opencode credential(s): ${shown} (from auth.json)`,
  };
}

/**
 * Run `opencode auth list` and parse it. `extraArgs` is a test seam:
 * `probeOpencodeAuth(process.execPath, ["-e", script])` runs canned output
 * through the full spawn path without touching the real CLI.
 * When the CLI probe itself fails, falls back to `auth.json` so provider
 * changes are still picked up automatically.
 */
export async function probeOpencodeAuth(
  executable: string,
  extraArgs: string[] = [],
  opts: { homeDir?: string; dataDir?: string } = {},
): Promise<AuthStatus> {
  const launch = resolveLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...extraArgs, "auth", "list"],
    env: launch.env,
  });
  if (res.timedOut) {
    return (
      readOpencodeAuthFile(opts) ?? {
        authenticated: false,
        method: "unknown",
        detail: withStderrTail("opencode auth probe timed out", res.stderr),
      }
    );
  }
  if (res.code === null) {
    return (
      readOpencodeAuthFile(opts) ?? {
        authenticated: false,
        method: "unknown",
        detail: "opencode auth probe could not start",
      }
    );
  }
  if (res.code !== 0) {
    return (
      readOpencodeAuthFile(opts) ?? {
        authenticated: false,
        method: "unknown",
        detail: withStderrTail(`opencode auth probe failed (exit ${String(res.code)})`, res.stderr),
      }
    );
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

  public override async models(): Promise<RuntimeModel[]> {
    // Three-level fallback: `models --verbose` (per-model variant metadata)
    // ∪ plain `models` (either listing can miss entries across versions /
    // config layering) → static fallback. Catalog calls hit the network
    // (regularly >8s), so both probes run in parallel under a 15s budget
    // instead of sequentially — worst case stays 15s, not 30s.
    // The merged list primes the `--variant` gating cache.
    const status = await this.detect();
    const executable = status.installed ? status.executable : opencodeDefinition.executable.command;
    const launch = resolveLaunch(executable);
    const [verbose, plain] = await Promise.all([
      runCommand({
        command: launch.command,
        args: [...launch.prependArgs, "models", "--verbose"],
        env: launch.env,
        timeout: 15_000,
      }),
      discoverModels(executable, ["models"], [], 15_000),
    ]);
    let parsed: RuntimeModel[] | null = null;
    if (!verbose.timedOut && verbose.code === 0) {
      parsed = parseOpenCodeModels(verbose.stdout);
    }
    const merged = mergeOpencodeModelLists(parsed, plain);
    if (merged) {
      rememberOpencodeModels(merged);
      rememberLiveModels(opencodeDefinition.identity.id, merged);
      return merged;
    }
    return super.models();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const { cwd, model, reasoning, mcpServers, workspace, resumeSessionId } = options ?? {};
    // Reject unknown model picks before anything spawns: a refused turn
    // never mints a stillborn native session. Fail-open when the catalog was
    // never surfaced (refresh probes once on a primed miss).
    await assertKnownModel(
      opencodeDefinition.identity.id,
      model,
      opencodeDefinition.models?.fallbackModels ?? [],
      () => this.models(),
    );
    const status = await this.detect();
    const command = status.installed ? status.executable : opencodeDefinition.executable.command;
    const sid = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new OpencodeSession({
      id: sid,
      command,
      cwd,
      model,
      reasoning,
      mcpServers,
      workspace,
      resumeSessionId,
    });
  }

  public override async auth(): Promise<AuthStatus> {
    const status = await this.detect();
    if (!status.installed) {
      // No binary — auth.json may still exist (e.g. CLI removed, creds kept).
      return (
        readOpencodeAuthFile() ?? {
          authenticated: false,
          method: "unknown",
          detail: "opencode is not installed — auth status unknown",
        }
      );
    }
    return probeOpencodeAuth(status.executable);
  }

  public override async mcp(): Promise<McpServerInfo[]> {
    const status = await this.detect();
    if (!status.installed) return [];
    return discoverMcp(status.executable, ["mcp", "list"]);
  }

  /**
   * Read-only skill metadata (never the body). File scan only — opencode
   * has no `skills` subcommand, so there is nothing to probe. `cwd` opts
   * into the project root; omitted = global roots only.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public override async skills(options?: { cwd?: string }): Promise<RuntimeSkill[]> {
    return discoverSkills(skillSearchDirs({ cwd: options?.cwd }));
  }

  /**
   * Read-only plugin metadata (never file contents or inline secrets).
   * Merges the `plugin` array from global + project `opencode.json(c)`
   * with local `plugins/` directories. No `plugin list` subcommand
   * exists, so this is a file scan. `cwd` opts into the project roots;
   * omitted = global roots only.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public override async plugins(options?: { cwd?: string }): Promise<RuntimePlugin[]> {
    const opts = { cwd: options?.cwd };
    return discoverPlugins(pluginConfigFiles(opts), pluginSearchDirs(opts));
  }
}
