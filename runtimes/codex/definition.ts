import type { RuntimeDefinition } from "../../src/definition/index.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import { sanitizeConfigId } from "../../src/definition/session-inputs.js";
import { floorsFor } from "../../src/definition/compat.js";
import type { RuntimeModel } from "../../src/definition/model.js";
import type { McpServerInfo } from "../../src/definition/mcp.js";
import type { RuntimePlugin } from "../../src/definition/plugin.js";
import { sanitizeModelId } from "../../src/definition/model.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import type { ResolvedLaunch } from "../../src/discovery/launch.js";
import { resolveLaunch } from "../../src/discovery/launch.js";
import { compareSemver, parseSemver } from "../../src/discovery/version.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Codex runtime definition — Phase 13 pressure test
 * Mirrors open-design's codex def:
 *  new session: codex exec --json --skip-git-repo-check [-C <dir>] [--model <id>] [--sandbox <mode>]
 *  resume:      codex exec resume --json <thread_id>
 * Prompt via stdin.
 */
export const codexDefinition: RuntimeDefinition = {
  identity: {
    id: "codex",
    name: "Codex",
    description: "OpenAI Codex CLI",
  },
  executable: {
    command: "codex",
    versionArgs: ["--version"],
    // Exec flags (`--add-dir`, `-p`, `--sandbox`) only appear under
    // `codex exec --help`, never in the top-level help (same shape as
    // claude's `claude -p --help`) — probe there for flag inventory.
    helpArgs: ["exec", "--help"],
    // The Codex desktop app (macOS bundle id `com.openai.codex`) ships the
    // CLI inside its app bundle without adding it to PATH unless the user
    // runs "Install command line tool". Last-resort fallback below PATH —
    // an explicit npm/Homebrew install always wins. Unverifiable without a
    // Mac on hand: entries are data, skipped when absent, covered by
    // expansion unit tests, not live runs.
    extraProbePaths: [
      "/Applications/Codex.app/Contents/Resources/codex",
      "~/Applications/Codex.app/Contents/Resources/codex",
    ],
    registryId: "@openai/codex",
  },
  input: {
    type: "stdin",
  },
  transport: {
    type: "stdio",
  },
  capabilities: {
    streaming: true,
    sessionResume: true,
    modelSelection: true,
    reasoning: true,
    images: true,
    // --add-dir / --sandbox (+ resume -c equivalents) and
    // --dangerously-bypass-approvals-and-sandbox are wired; permissionMode
    // has no codex flag and is rejected loudly.
    workspace: true,
    agentSelection: false,
    // stdin carries one prompt per exec — no mid-run channel.
    midRunInput: false,
    historySeed: false,
    // False on evidence, not on omission: across 175 rollouts there were zero
    // real `spawn_agent` tool calls (the 77 textual hits are all aspirational
    // system-prompt copy), and `session_meta` carries no parent link.
    subAgents: false,
    // No verified -c keys for system instructions / token budgets.
    systemPrompt: false,
    maxTokens: false,
    // No cost-budget flag on `codex exec` (verified in --help).
    costBudget: false,
    // `--output-schema <FILE>` (verified on create + resume branches).
    structuredOutput: true,
    toolAllowlist: false,
    // `-p/--profile` (verified in `codex exec --help`).
    profileSelection: true,
  },
  session: {
    persistent: true,
  },
  versionPolicy: {
    // Floor from open-design's codex-model-preflight: production traces show
    // <0.143.0 rejecting ChatGPT-backed models (e.g. gpt-5.6-terra) that
    // 0.143.0+ starts fine. Tested = this library's verified installs.
    minimum: "0.143.0",
    tested: ["0.150.1", "0.156.1", "0.157.1", "0.159.2"],
  },
  models: {
    // No static fallback: the shipped list goes stale fast (and a wrong
    // list is worse than none). Live `debug models` or [] ("unknown").
    fallbackModels: [],
    listCommand: ["debug", "models"],
  },
};

export type CodexBuildArgsOptions = {
  model?: string;
  resumeThreadId?: string;
  /** Session cwd pinned via `-C` on create (daemon parity; resume rejects `-C`). */
  cwd?: string;
  /** Extra writable roots via `--add-dir` on create (resume rejects it). */
  addDirs?: string[];
  sandboxMode?: string;
  /**
   * Config profile via `-p/--profile` on create (layers
   * `$CODEX_HOME/<name>.config.toml`). Create-only: `exec resume` has no
   * `-p` flag, so resume + profile rejects loudly.
   */
  profile?: string;
  /**
   * Unified dangerous opt-in — maps to
   * `--dangerously-bypass-approvals-and-sandbox` (verified on both
   * branches of `codex exec --help`).
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Route approval requests through automatic review (`--approve-for-me`,
   * verified in `codex exec --help`: reviewer agent + forced
   * `workspace-write` + `on-request` policy). Approval delegation, not a
   * permission grant — sandbox boundaries stay intact. Create-only
   * (`exec resume` has no such flag). Mutually exclusive with
   * `sandboxMode` and `dangerouslySkipPermissions` (the CLI rejects the
   * combination, so this throws first with a readable error).
   */
  approveForMe?: boolean;
  /** Unified reasoning knob (Phase 17) — maps to `-c model_reasoning_effort=`. */
  reasoning?: ReasoningOptions;
  /**
   * Service tier override (e.g. `"priority"`) — maps to `-c service_tier=`.
   * `"default"` (and absent) omit the flag. Session exposure needs per-model
   * tier metadata (see the effective-default-model follow-up), so this stays
   * a buildArgs-level knob for explicit callers.
   */
  serviceTier?: string;
  /**
   * Disable codex plugins (`--disable plugins`). Explicit option wins;
   * `OD_CODEX_DISABLE_PLUGINS=1` env also triggers it (daemon parity).
   */
  disablePlugins?: boolean;
  /** Phase 26: image files to attach via `-i` (must precede threadId on resume). */
  images?: string[];
  /**
   * Staged schema file for `--output-schema` (verified on both branches).
   * The session stages the normalized JSON and owns the temp-file
   * lifecycle; buildArgs only hides the flag (Rule 2, MCP-config pattern).
   */
  outputSchemaFile?: string;
};

/**
 * Daemon parity (`defs/codex.ts: codexNeedsDangerFullAccessSandbox`):
 * Codex has no working OS-level sandbox on Windows (workspace-write blocks
 * shell there), so win32/WSL default to `danger-full-access`; POSIX keeps
 * `workspace-write`. An explicit `sandboxMode` always wins; `OD_CODEX_SANDBOX`
 * env overrides the platform default. Pure (platform/env injectable) for tests.
 */
export function resolveCodexSandboxMode(
  sandboxMode: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (sandboxMode) return sandboxMode;
  if (env["OD_CODEX_SANDBOX"]?.trim() === "danger-full-access") return "danger-full-access";
  if (platform === "win32") return "danger-full-access";
  if (env["WSL_DISTRO_NAME"]?.trim()) return "danger-full-access";
  return "workspace-write";
}

export function buildCodexArgs(options: CodexBuildArgsOptions = {}): string[] {
  // `--approve-for-me` forces workspace-write + on-request review itself
  // (verified in codex source: conflicts_with sandbox_mode +
  // dangerously_bypass) — combining them is a caller bug, fail fast with
  // a readable error instead of the CLI's conflict error.
  if (options.approveForMe === true) {
    const conflicts: string[] = [];
    if (options.sandboxMode !== undefined) conflicts.push("sandboxMode (--sandbox)");
    if (options.dangerouslySkipPermissions === true) {
      conflicts.push("dangerouslySkipPermissions (--dangerously-bypass-approvals-and-sandbox)");
    }
    if (conflicts.length > 0) {
      throw new RuntimeSessionError(
        `codex approveForMe conflicts with ${conflicts.join(", ")}: --approve-for-me already forces workspace-write + on-request review`,
        { runtime: "codex" },
      );
    }
  }
  // cwd / addDirs / profile / approveForMe are create-only flags:
  // `exec resume` rejects them, so passing them with a resume id fails
  // fast here instead of dying mid-run with a cryptic CLI error.
  if (options.resumeThreadId) {
    const createOnly: string[] = [];
    if (options.cwd) createOnly.push("cwd (-C)");
    if (options.addDirs && options.addDirs.length > 0) createOnly.push("addDirs (--add-dir)");
    if (options.profile) createOnly.push("profile (-p)");
    if (options.approveForMe === true) createOnly.push("approveForMe (--approve-for-me)");
    if (createOnly.length > 0) {
      throw new RuntimeSessionError(
        `codex resume rejects create-only inputs (${createOnly.join(", ")}) — the resumed thread carries the dirs/profile/review mode granted at creation`,
        { runtime: "codex" },
      );
    }
  }
  // approveForMe owns the sandbox (forced workspace-write); an explicit
  // sandboxMode above already threw, and the platform default is ignored.
  const sandbox =
    options.approveForMe === true
      ? "workspace-write"
      : resolveCodexSandboxMode(options.sandboxMode);
  // Model ids ride argv (`--model <id>`) — reject flag-shaped ids before
  // the CLI can parse them as options. Sanitized once, reused below.
  let model: string | undefined;
  if (options.model !== undefined) {
    const clean = sanitizeModelId(options.model);
    if (clean === null) {
      throw new RuntimeSessionError(`invalid codex model id: ${JSON.stringify(options.model)}`, {
        runtime: "codex",
      });
    }
    // `default` means "CLI config" — omit the flag (daemon parity).
    model = clean === "default" ? undefined : clean;
  }
  // Daemon parity: workspace-write needs explicit network access on both
  // branches, otherwise follow-up turns lose net and break prefix-cache reuse.
  const networkArgs =
    sandbox === "workspace-write" ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
  // Service tier override (both branches take `-c`; only `--sandbox`/`-C`
  // are create-only). `"default"` omits the flag. The value interpolates
  // into a TOML string, so breakout chars (`"`, `\`, newlines) reject
  // loudly instead of rewriting the config line.
  let tierArgs: string[] = [];
  if (options.serviceTier && options.serviceTier !== "default") {
    if (/["\\\r\n]/.test(options.serviceTier)) {
      throw new RuntimeSessionError(`invalid serviceTier: ${JSON.stringify(options.serviceTier)}`, {
        runtime: "codex",
      });
    }
    tierArgs = ["-c", `service_tier="${options.serviceTier}"`];
  }
  // Plugin disable is a global flag, valid on resume too.
  const pluginArgs =
    options.disablePlugins === true || process.env["OD_CODEX_DISABLE_PLUGINS"] === "1"
      ? ["--disable", "plugins"]
      : [];
  // Explicit dangerous opt-in (verified flag on both branches).
  const bypassArgs =
    options.dangerouslySkipPermissions === true
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [];
  if (options.resumeThreadId) {
    const args: string[] = ["exec", "resume", "--json", "--skip-git-repo-check"];
    if (model) args.push("--model", model);
    // `exec resume` rejects `--sandbox` (create-only flag) — the same mode
    // must go through `-c`, or the follow-up turn dies before its first event.
    args.push("-c", `sandbox_mode="${sandbox}"`);
    args.push(...networkArgs);
    args.push(...pluginArgs);
    args.push(...bypassArgs);
    // Quoted: `-c` takes TOML, and a bare word is not a valid TOML string.
    if (options.reasoning) args.push("-c", `model_reasoning_effort="${options.reasoning.effort}"`);
    args.push(...tierArgs);
    if (options.images) {
      for (const f of options.images) {
        args.push("-i", f);
      }
    }
    // Thread id is the positional SESSION_ID and must come after the flags.
    // NOTE: no `-C`/`--add-dir`/`-p`/`--approve-for-me` here — resume
    // rejects all four; the resumed session carries the dirs/profile/
    // review mode granted at creation (daemon parity, enforced by the
    // guard above). `--output-schema` IS valid on resume (verified).
    if (options.outputSchemaFile) args.push("--output-schema", options.outputSchemaFile);
    args.push(options.resumeThreadId);
    return args;
  }
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];
  if (model) args.push("--model", model);
  if (options.approveForMe === true) {
    // The flag owns sandbox + policy (forced workspace-write); emitting
    // `--sandbox` alongside would trip the CLI's own conflict error.
    args.push("--approve-for-me");
  } else {
    args.push("--sandbox", sandbox);
  }
  args.push(...networkArgs);
  args.push(...pluginArgs);
  args.push(...bypassArgs);
  if (options.reasoning) args.push("-c", `model_reasoning_effort="${options.reasoning.effort}"`);
  args.push(...tierArgs);
  // `-C/--cd` pins the session cwd on create (daemon parity);
  // `--add-dir` grants extra writable roots (verified in --help).
  if (options.cwd) args.push("-C", options.cwd);
  if (options.addDirs) {
    for (const dir of options.addDirs) {
      args.push("--add-dir", dir);
    }
  }
  // Profile names ride argv (`-p <name>`) — same injection class as models.
  const profile = sanitizeConfigId(options.profile, "profile", "codex");
  if (profile) args.push("-p", profile);
  if (options.outputSchemaFile) args.push("--output-schema", options.outputSchemaFile);
  if (options.images) {
    for (const f of options.images) {
      args.push("-i", f);
    }
  }
  return args;
}

/**
 * Write the normalized schema JSON to a unique temp file for
 * `--output-schema`; returns its path. The caller (CodexSession) deletes
 * it on close — never leak temp files. Mirrors the claude MCP-config
 * pattern (session-owned lifecycle, builder only hides the flag).
 */
export function writeCodexSchemaFile(schemaJson: string, hint = "session"): string {
  const safe = hint.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = join(
    tmpdir(),
    `agent-runtimes-codex-schema-${safe}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}.json`,
  );
  writeFileSync(file, schemaJson, "utf-8");
  return file;
}

export type CodexLaunch = ResolvedLaunch;

/**
 * Codex entry point to the shared shim-aware launch
 * (`src/discovery/launch.ts`). Kept as an alias so existing callers and
 * tests keep working; new code should import `resolveLaunch` directly.
 */
export function resolveCodexLaunch(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): CodexLaunch {
  return resolveLaunch(executable, platform);
}

/**
 * Parse `codex mcp list` table output (verified on 0.150.1):
 * columns `Name  Command  Args  Env  Cwd  Status  Auth`, `-` for empty
 * cells, e.g.
 * `github  npx  -y @modelcontextprotocol/server-github  -  -  enabled  Unsupported`.
 * Never throws; unparseable input yields [] ("unknown", not an error).
 */
const CODEX_MCP_ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function parseCodexMcpList(stdout: string): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  for (const rawLine of stdout.replace(CODEX_MCP_ANSI, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Header (`Name  Command  Args ...`) and rule lines.
    if (/^name\b/i.test(line)) continue;
    if (/^[-=─\s]+$/.test(line)) continue;
    // Table cells are padded apart; single spaces inside a cell (e.g.
    // `C:\Program Files\...`) survive a 2+-space split.
    const cells = line
      .split(/\s{2,}/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const name = cells[0] ?? "";
    if (!name || name.length < 2) continue;
    if (/^checking\b/i.test(name)) continue;
    // A Status cell (`enabled`/`disabled`) is required — without it the
    // line can't be told apart from progress noise.
    const statusCell = cells.find((c) => /^(enabled|disabled)$/i.test(c));
    if (!statusCell) continue;
    const command = cells.length > 1 && cells[1] !== "-" ? cells[1] : undefined;
    out.push({
      name,
      ...(command === undefined ? {} : { command }),
      status: statusCell.toLowerCase(),
      source: "codex",
    });
  }
  return out;
}

/**
 * Parse `codex debug models` JSON (mirrors open-design parseCodexDebugModels).
 * Shape: `{models:[{slug|id, display_name|name, visibility}]}` or a bare array.
 * Returns null when the output isn't a usable model list (caller falls back).
 */
export function parseCodexDebugModels(stdout: string): RuntimeModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as { models?: unknown };
  const models = Array.isArray(parsed) ? parsed : rec.models;
  if (!Array.isArray(models)) return null;
  const out: RuntimeModel[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry["visibility"] === "hidden") continue;
    const id =
      (typeof entry["slug"] === "string" && entry["slug"].trim()) ||
      (typeof entry["id"] === "string" && entry["id"].trim()) ||
      "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      (typeof entry["display_name"] === "string" && entry["display_name"].trim()) ||
      (typeof entry["name"] === "string" && entry["name"].trim()) ||
      id;
    out.push({ id, name, provider: "openai" });
  }
  return out.length > 0 ? out : null;
}

/**
 * Resolve the codex user config path: `$CODEX_HOME/config.toml`, else
 * `~/.codex/config.toml`. Mirrors daemon `resolveCodexConfigPath`.
 */
export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return join(home, "config.toml");
}

export interface CodexDefaultModel {
  /** Root `model = "..."` — the effective default when no explicit model is passed. */
  model: string | null;
  /** Root `model_provider = "..."` — non-openai means custom routing. */
  modelProvider: string | null;
  /** True when settings replace the model source independently of the root
   * model string (`[model_providers.openai]`, `*_base_url`,
   * `model_catalog_json`, `profile`, `project_root_markers`). */
  hasOverlay: boolean;
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function tomlRootValue(line: string, key: string): string | null {
  const pattern = `(?:${key}|"${key}"|'${key}')`;
  const match = new RegExp(`^${pattern}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`).exec(line);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? "").trim();
  return value || null;
}

function tomlAssigns(line: string, key: string): boolean {
  const pattern = `(?:${key}|"${key}"|'${key}')`;
  return new RegExp(`^${pattern}\\s*=`).test(line);
}

/**
 * Read the effective default model from the codex config (line-parsed, no
 * TOML dependency — only root scalars are needed). Returns null when the
 * file is missing/unreadable or declares no root model.
 */
export function readCodexDefaultModel(
  opts: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): CodexDefaultModel | null {
  const file = opts.codexHome
    ? join(opts.codexHome, "config.toml")
    : resolveCodexConfigPath(opts.env);
  let content: string;
  try {
    if (!existsSync(file)) return null;
    content = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let model: string | null = null;
  let modelProvider: string | null = null;
  let hasOverlay = false;
  let inRootTable = true;
  for (const raw of content.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inRootTable = false;
      if (/^\[model_providers\.openai\]$/.test(line)) hasOverlay = true;
      continue;
    }
    if (
      tomlAssigns(line, "model_catalog_json") ||
      tomlAssigns(line, "openai_base_url") ||
      tomlAssigns(line, "chatgpt_base_url") ||
      tomlAssigns(line, "base_url")
    ) {
      hasOverlay = true;
    }
    if (!inRootTable) continue;
    if (tomlAssigns(line, "profile") || tomlAssigns(line, "project_root_markers")) {
      hasOverlay = true;
    }
    model = tomlRootValue(line, "model") ?? model;
    modelProvider = tomlRootValue(line, "model_provider") ?? modelProvider;
  }
  if (!model) return null;
  return { model, modelProvider, hasOverlay };
}

/**
 * Read configured codex plugins from `config.toml` `[plugins."id"]`
 * tables (verified live: each carries `enabled = true/false`). Line-parsed
 * like `readCodexDefaultModel` — no TOML dependency. Only ids + enabled
 * are surfaced. Returns null when the file is missing/unreadable (not an
 * error); a readable file with no plugin tables yields [].
 */
export function readCodexPluginsFile(
  opts: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): RuntimePlugin[] | null {
  const file = opts.codexHome
    ? join(opts.codexHome, "config.toml")
    : resolveCodexConfigPath(opts.env);
  let content: string;
  try {
    if (!existsSync(file)) return null;
    content = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const out: RuntimePlugin[] = [];
  let current: string | null = null;
  let currentEnabled: boolean | undefined;
  const flush = (): void => {
    if (current) {
      out.push({
        id: current,
        source: "global",
        kind: "marketplace",
        ...(currentEnabled !== undefined ? { enabled: currentEnabled } : {}),
      });
    }
    current = null;
    currentEnabled = undefined;
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      flush();
      const quoted = /^\[plugins\."([^"]+)"\]$/.exec(line)?.[1];
      const bare = /^\[plugins\.([A-Za-z0-9@_.-]+)\]$/.exec(line)?.[1];
      const id = (quoted ?? bare ?? "").trim();
      current = id && id.length <= 200 ? id : null;
      continue;
    }
    if (current) {
      const enabled = /^enabled\s*=\s*(true|false)/.exec(line)?.[1];
      if (enabled !== undefined) currentEnabled = enabled === "true";
    }
  }
  flush();
  return out;
}

/**
 * Known model→minimum-CLI contracts — sourced from the evidence-backed
 * `VERSION_FLOORS` table (`src/definition/compat.ts`), never lore.
 * Extend only with observed incompatibilities (each needs a proving test).
 */
function codexModelCliFloors(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of floorsFor("codex")) {
    if (f.model) out[f.model] = f.minimum;
  }
  return out;
}

export type CodexModelSupport =
  { supported: true } | { supported: false; model: string; required: string };

/**
 * Preflight: can `cliVersion` run `model`? Fail-open everywhere judgment is
 * impossible — unknown model, unreadable/unparseable version, custom
 * provider routing, or a compatibility overlay (custom endpoint/catalog) all
 * pass. Only a proven floor violation with a stock backend fails.
 */
export function checkCodexModelSupport(
  explicitModel: string | undefined,
  cliVersion: string | null,
  opts: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): CodexModelSupport {
  const trimmed = explicitModel?.trim() || "";
  const configured = readCodexDefaultModel(opts);
  const effective = trimmed || configured?.model || "";
  if (!effective) return { supported: true };
  const required = codexModelCliFloors()[effective];
  if (!required) return { supported: true };
  if (
    !trimmed &&
    configured?.modelProvider &&
    configured.modelProvider.toLowerCase() !== "openai"
  ) {
    return { supported: true };
  }
  if (configured?.hasOverlay) return { supported: true };
  const current = cliVersion ? parseSemver(cliVersion) : null;
  const floor = parseSemver(required);
  if (!current || !floor) return { supported: true };
  if (compareSemver(current, floor) >= 0) return { supported: true };
  return { supported: false, model: effective, required };
}
