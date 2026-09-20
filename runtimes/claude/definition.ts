import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDefinition } from "../../src/definition/index.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";
import { sanitizeModelId } from "../../src/definition/model.js";
import { RuntimeSessionError } from "../../src/core/errors.js";

/**
 * Claude Code runtime definition — Phase 12
 * Mirrors open-design's claude def (backgrounds_from_chatgpt.md:100-122):
 *  claude -p --input-format stream-json --output-format stream-json --verbose
 *  [--model <id>] [--add-dir <path>] [--resume <id> | --session-id <id>]
 *  [--permission-mode bypassPermissions]
 */
export const claudeDefinition: RuntimeDefinition = {
  identity: {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic Claude Code CLI",
  },
  executable: {
    command: "claude",
    // Drop-in forks shipping a `claude`-compatible argv (e.g. openclaude).
    // Tried in order when `claude` itself is not on PATH.
    aliases: ["openclaude"],
    versionArgs: ["--version"],
    // Subcommand flags (`--add-dir`, `--include-partial-messages`) only
    // appear under `claude -p --help`, never in the top-level help
    // (open-design issue #430) — probe there for capability detection.
    helpArgs: ["-p", "--help"],
    registryId: "@anthropic-ai/claude-code",
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
    workspace: true,
  },
  session: {
    persistent: true,
  },
  // Verified installs only (live runs + fixture provenance in comments).
  versionPolicy: {
    tested: ["2.1.112", "2.1.187"],
  },
  models: {
    // NOTE: no listCommand — `claude` has no list-models subcommand
    // (`claude --models` is `unknown option`; the default `["models"]`
    // would run the agent with "models" as the prompt). Fallback only:
    // `default` = CLI config (omitted from argv), the three stable aliases,
    // plus full names that shipped (mirrors open-design's fallback list).
    fallbackModels: [
      { id: "default", provider: "anthropic", name: "Default (CLI config)" },
      { id: "sonnet", provider: "anthropic", name: "Sonnet" },
      { id: "opus", provider: "anthropic", name: "Opus" },
      { id: "haiku", provider: "anthropic", name: "Haiku" },
      { id: "fable", provider: "anthropic", name: "Fable" },
      { id: "claude-opus-5", provider: "anthropic", name: "claude-opus-5" },
      { id: "claude-sonnet-5", provider: "anthropic", name: "claude-sonnet-5" },
      { id: "claude-fable-5", provider: "anthropic", name: "claude-fable-5" },
      { id: "claude-opus-4-5", provider: "anthropic", name: "claude-opus-4-5" },
      { id: "claude-sonnet-4-5", provider: "anthropic", name: "claude-sonnet-4-5" },
      { id: "claude-haiku-4-5", provider: "anthropic", name: "claude-haiku-4-5" },
    ],
  },
};

export type ClaudeBuildArgsOptions = {
  model?: string;
  sessionId?: string;
  resumeId?: string;
  addDirs?: string[];
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  /**
   * Unified reasoning knob (Phase 17) — maps to `--effort <level>`.
   * Verified on Claude Code 2.1.112 (`claude --help`):
   * `--effort <level>  Effort level for the current session
   * (low, medium, high, xhigh, max)`. The unified `low|medium|high`
   * subset passes through verbatim.
   */
  reasoning?: ReasoningOptions;
  /**
   * Pre-written `--mcp-config` file (Phase 21) — see
   * buildClaudeMcpConfig/writeClaudeMcpConfigFile. The session owns the
   * temp file lifecycle; buildArgs only hides the flag (Rule 2).
   */
  mcpConfigFile?: string;
  /**
   * Pre-derived `--allowedTools` list (Phase 21) — see
   * buildClaudeMcpAllowedTools. Headless MCP turns need the configured
   * servers pre-approved, otherwise every tool call fails with
   * "haven't granted it yet". Scoped to `mcp__<server>__*` (least
   * privilege — never bypassPermissions by default).
   */
  allowedTools?: string[];
};

/**
 * Rule 2: hide CLI flags behind buildArgs()
 */
export function buildClaudeArgs(options: ClaudeBuildArgsOptions = {}): string[] {
  const args: string[] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (options.model !== undefined) {
    // Model ids ride argv (`--model <id>`) — reject flag-shaped ids before
    // the CLI can parse them as options. `default` means "CLI config" and
    // omits the flag (daemon parity) instead of asking for a model named that.
    const model = sanitizeModelId(options.model);
    if (model === null) {
      throw new RuntimeSessionError(`invalid claude model id: ${JSON.stringify(options.model)}`, {
        runtime: "claude",
      });
    }
    if (model !== "default") args.push("--model", model);
  }
  if (options.reasoning) {
    args.push("--effort", options.reasoning.effort);
  }
  if (options.addDirs) {
    for (const dir of options.addDirs) {
      args.push("--add-dir", dir);
    }
  }
  if (options.resumeId) {
    args.push("--resume", options.resumeId);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    // `--allowedTools <tools...>`: comma- or space-separated (claude --help).
    args.push("--allowedTools", options.allowedTools.join(" "));
  }
  if (options.mcpConfigFile) {
    args.push("--mcp-config", options.mcpConfigFile);
  }
  return args;
}

/**
 * Build the stdin payload for `--input-format stream-json`.
 * Verified live against Claude Code 2.1.187: with stream-json input the
 * positional prompt is ignored and stdin EOF ends the turn empty, so the
 * prompt MUST travel here (argv carries no prompt in this mode).
 * With images (Phase 26) the content array is used:
 * `{role:"user",content:[{type:"text",text},{type:"image",source:{type:"base64",media_type,data}}]}`.
 */
export function buildClaudeStdinPrompt(
  prompt: string,
  images?: Array<{ base64: string; mimeType: string }>,
): string {
  if (!images || images.length === 0) {
    return JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n";
  }
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.base64 },
    });
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/**
 * Render agent-agnostic MCP servers as a Claude `--mcp-config` document
 * (`{"mcpServers": {...}}`, `.mcp.json` shape: string command, args array,
 * env map). Keys present only when non-empty — a bare `{command}` is the
 * universally valid minimum.
 */
export function buildClaudeMcpConfig(servers: McpServer[]): string {
  const mcpServers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  > = {};
  for (const s of servers) {
    const entry: { command: string; args?: string[]; env?: Record<string, string> } = {
      command: s.command,
    };
    if (s.args !== undefined && s.args.length > 0) entry.args = [...s.args];
    if (s.env !== undefined && Object.keys(s.env).length > 0) entry.env = { ...s.env };
    mcpServers[s.name] = entry;
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Derive the `--allowedTools` list for configured MCP servers
 * (`mcp__<server>__*` per server — verified against `claude --help`:
 * "Comma or space-separated list of tool names").
 */
export function buildClaudeMcpAllowedTools(servers: McpServer[]): string[] {
  return servers.map((s) => `mcp__${s.name}__*`);
}

/**
 * Write the MCP config to a unique temp file; returns its path. The caller
 * (ClaudeSession) deletes it on close — never leak temp files.
 */
export function writeClaudeMcpConfigFile(servers: McpServer[], hint = "session"): string {
  const safe = hint.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = join(
    tmpdir(),
    `agent-runtimes-claude-mcp-${safe}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}.json`,
  );
  writeFileSync(file, buildClaudeMcpConfig(servers), "utf-8");
  return file;
}
