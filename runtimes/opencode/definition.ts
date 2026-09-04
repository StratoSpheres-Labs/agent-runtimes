import type { RuntimeDefinition } from "../../src/definition/index.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";

/**
 * OpenCode runtime definition — Task 9.1
 * Mirrors Dev_Docs/backgrounds_from_chatgpt.md opencode buildArgs:
 *  opencode run --format json [-m model] [-s session] [--variant x] [--agent x]
 */
export const opencodeDefinition: RuntimeDefinition = {
  identity: {
    id: "opencode",
    name: "OpenCode",
    description: "OpenCode local agent CLI",
  },
  executable: {
    command: "opencode",
    versionArgs: ["--version"],
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
  models: {
    fallbackModels: [
      { id: "opencode/mimo-v2.5-free", provider: "opencode", name: "Mimo v2.5 Free" },
      {
        id: "opencode/muse-spark-1.2-contributor-free",
        provider: "opencode",
        name: "Muse Spark Free",
      },
      { id: "opencode/gpt-5-nano", provider: "opencode", name: "GPT-5 Nano" },
    ],
    listCommand: ["models"],
  },
};

export type OpencodeBuildArgsOptions = {
  model?: string;
  sessionId?: string;
  variant?: string;
  agent?: string;
  /** Unified reasoning knob (Phase 17) — maps to `--variant`. */
  reasoning?: ReasoningOptions;
  /** Extra args for `opencode run --format` — default "json" */
  format?: "json" | "default";
  /** Workspace dir — mirrors daemon's appendOpenCodeWorkspaceDir (`--dir`). */
  dir?: string;
};

/**
 * Task 9.2 — hide CLI flags behind buildArgs() (Rule 2).
 * Caller never sees --resume/-s/--model/--variant.
 */
export function buildOpencodeArgs(options: OpencodeBuildArgsOptions = {}): string[] {
  const format = options.format ?? "json";
  const args: string[] = ["run", "--format", format];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  // Explicit `variant` wins over the unified knob; exactly one --variant is emitted.
  const variant = options.variant ?? options.reasoning?.effort;
  if (variant) {
    args.push("--variant", variant);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.dir) {
    args.push("--dir", options.dir);
  }
  return args;
}

/**
 * Render agent-agnostic MCP servers as an opencode config document
 * (`{"mcp": {...}}`, local-server shape with array command), delivered via
 * the `OPENCODE_CONFIG_CONTENT` env var — `opencode run` takes no MCP flags.
 */
export function buildOpencodeMcpConfig(servers: McpServer[]): string {
  const mcp: Record<
    string,
    { type: string; command: string[]; enabled: boolean; environment?: Record<string, string> }
  > = {};
  for (const s of servers) {
    const entry: {
      type: string;
      command: string[];
      enabled: boolean;
      environment?: Record<string, string>;
    } = { type: "local", command: [s.command, ...(s.args ?? [])], enabled: true };
    if (s.env !== undefined && Object.keys(s.env).length > 0) entry.environment = { ...s.env };
    mcp[s.name] = entry;
  }
  return JSON.stringify({ mcp });
}
