import type { RuntimeDefinition } from "../../src/definition/index.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { RuntimeModel, ModelReasoningOption } from "../../src/definition/model.js";
import { sanitizeModelId } from "../../src/definition/model.js";
import { RuntimeSessionError } from "../../src/core/errors.js";

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
    // Daemon tries the standalone binary first (`bin: opencode-cli`).
    aliases: ["opencode-cli"],
    versionArgs: ["--version"],
    // npm-global bundle + bun installs outside PATH (win32); `~` expands
    // against the user home, missing entries are skipped downstream.
    extraProbePaths: [
      "~/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe",
      "~/AppData/Local/Programs/bun/bin/opencode.exe",
    ],
    registryId: "opencode-ai",
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
  // No minimum encoded: no verified floor for `--verbose`/catalog behavior
  // across 1.18.x — only list what live runs actually saw. Extend when a
  // real incompatibility is observed, not sooner.
  versionPolicy: {
    tested: ["1.18.27", "1.18.30", "1.18.31"],
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
  /**
   * Last live model list for `--variant` gating (defaults to the module
   * cache primed by `models()`). Lets unit tests inject fixtures without
   * spawning the CLI.
   */
  knownModels?: RuntimeModel[];
};

/**
 * Task 9.2 — hide CLI flags behind buildArgs() (Rule 2).
 * Caller never sees --resume/-s/--model/--variant.
 */
export function buildOpencodeArgs(options: OpencodeBuildArgsOptions = {}): string[] {
  const format = options.format ?? "json";
  const args: string[] = ["run", "--format", format];
  // Thinking blocks only stream in JSON mode and only with `--thinking`
  // (verified live on 1.18.31); without it the parser's `reasoning` branch
  // would never fire. Display-only flag — model behavior untouched.
  if (format === "json") args.push("--thinking");
  if (options.model !== undefined) {
    // Model ids ride argv (`--model <id>`) — reject flag-shaped ids before
    // the CLI can parse them as options. `default` means "CLI config" and
    // omits the flag (daemon parity) instead of asking for a model named that.
    const model = sanitizeModelId(options.model);
    if (model === null) {
      throw new RuntimeSessionError(`invalid opencode model id: ${JSON.stringify(options.model)}`, {
        runtime: "opencode",
      });
    }
    if (model !== "default") args.push("--model", model);
  }
  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  // Explicit `variant` wins over the unified knob; exactly one --variant is emitted.
  // Gated: only a variant the model actually advertises is sent (see
  // supportsOpencodeVariant) — unknown pairs omit the flag and run the base
  // model instead of failing the turn on an invalid value.
  const requested = options.variant ?? options.reasoning?.effort;
  if (requested !== undefined) {
    const variant = sanitizeOpencodeVariant(requested, "opencode");
    if (supportsOpencodeVariant(options.model, variant, options.knownModels)) {
      args.push("--variant", variant);
    }
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
 * Variant ids ride argv too (`--variant <id>`) — same injection class as
 * model ids. Caller-supplied `variant` must match the CLI's key shape;
 * the unified `reasoning.effort` union already satisfies it by type.
 */
const OPENCODE_VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function sanitizeOpencodeVariant(variant: string, runtime: string): string {
  const trimmed = variant.trim();
  if (!OPENCODE_VARIANT_ID.test(trimmed)) {
    throw new RuntimeSessionError(`invalid opencode variant id: ${JSON.stringify(variant)}`, {
      runtime,
    });
  }
  return trimmed;
}

/** `provider/model` id lines in `opencode models [--verbose]` output. */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/**
 * Parse `opencode models --verbose`: each `provider/model` id line,
 * optionally followed by a `{...}` JSON metadata block carrying `variants`
 * (per-model reasoning keys — they differ per model: low/medium on one,
 * high/max on another). Plain id lines without metadata stay valid
 * (old-CLI compat). Returns null when nothing usable was found.
 */
export function parseOpenCodeModels(stdout: string): RuntimeModel[] | null {
  const lines = stdout.split("\n");
  const models: RuntimeModel[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const id = (lines[i] ?? "").trim();
    if (!OPENCODE_MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    let reasoningOptions: ModelReasoningOption[] = [];
    let displayName: string | undefined;
    if (lines[i + 1]?.trimStart().startsWith("{") === true) {
      // Accumulate lines until the buffer parses as a JSON object; a
      // truncated tail degrades to id-only instead of throwing.
      let buffer = "";
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        buffer += `${lines[j] ?? ""}\n`;
        if (lines[j]?.trimEnd().endsWith("}") !== true) continue;
        try {
          const parsed = JSON.parse(buffer) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const rec = parsed as Record<string, unknown>;
            const variants = rec["variants"];
            if (variants && typeof variants === "object" && !Array.isArray(variants)) {
              reasoningOptions = Object.keys(variants)
                .filter((key) => OPENCODE_VARIANT_ID.test(key))
                .map((key) => ({ id: key, label: key }));
            }
            const name = rec["name"];
            if (typeof name === "string" && name.trim()) displayName = name.trim();
          }
          end = j;
          break;
        } catch {
          // Nested objects close early — keep accumulating.
        }
      }
      i = Math.max(i, end);
    }
    const slash = id.indexOf("/");
    models.push({
      id,
      provider: id.slice(0, slash),
      name: displayName ?? id.slice(slash + 1),
      ...(reasoningOptions.length > 0 ? { reasoningOptions } : {}),
    });
  }
  return models.length > 0 ? models : null;
}

/**
 * Union verbose (metadata-rich) and plain model lists. Either source can miss
 * entries the other has (observed deltas across CLI versions and config
 * layering), so verbose-only would shrink the catalog; plain-only entries
 * carry no variant metadata. Verbose wins on id conflicts.
 * Returns null when both sides are empty (caller falls back to static).
 */
export function mergeOpencodeModelLists(
  verbose: RuntimeModel[] | null,
  plain: RuntimeModel[],
): RuntimeModel[] | null {
  if (!verbose && plain.length === 0) return null;
  const out = [...(verbose ?? [])];
  const seen = new Set(out.map((m) => m.id));
  for (const m of plain) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.length > 0 ? out : null;
}

let rememberedOpencodeModels: RuntimeModel[] | null = null;

/** Prime the `--variant` gating cache (called by `models()`; null = never fetched). */
export function rememberOpencodeModels(models: RuntimeModel[]): void {
  rememberedOpencodeModels = models;
}

/**
 * Whether `--variant <variant>` may be sent for `modelId`. Fail-open matrix:
 * - no variant → false (nothing to emit);
 * - no model, or list never fetched → true (no basis to judge — legacy emit);
 * - model unknown to the list, or model advertises no variants,
 *   or variant not advertised → false (omit the flag, run the base model).
 * `known` overrides the module cache (unit-test seam).
 */
export function supportsOpencodeVariant(
  modelId: string | undefined,
  variant: string | undefined,
  known: RuntimeModel[] | null = rememberedOpencodeModels,
): boolean {
  if (!variant) return false;
  if (!modelId) return true;
  if (known === null) return true;
  const live = known.find((m) => m.id === modelId);
  if (!live) return false;
  const options = live.reasoningOptions ?? [];
  return options.some((o) => o.id === variant);
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
