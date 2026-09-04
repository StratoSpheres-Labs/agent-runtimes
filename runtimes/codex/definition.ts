import type { RuntimeDefinition } from "../../src/definition/index.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { RuntimeModel } from "../../src/definition/model.js";
import { resolveShimTarget } from "../../src/discovery/npm-shim.js";

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
      { id: "o4-mini", provider: "openai", name: "o4-mini" },
      { id: "gpt-5", provider: "openai", name: "GPT-5" },
    ],
    listCommand: ["debug", "models"],
  },
};

export type CodexBuildArgsOptions = {
  model?: string;
  resumeThreadId?: string;
  addDirs?: string[];
  sandboxMode?: string;
  /** Unified reasoning knob (Phase 17) — maps to `-c model_reasoning_effort=`. */
  reasoning?: ReasoningOptions;
  /** Phase 26: image files to attach via `-i` (must precede threadId on resume). */
  images?: string[];
};

export function buildCodexArgs(options: CodexBuildArgsOptions = {}): string[] {
  if (options.resumeThreadId) {
    const args: string[] = ["exec", "resume", "--json", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    // `exec resume` rejects `--sandbox` (create-only flag) — the same mode
    // must go through `-c`, or the follow-up turn dies before its first event.
    if (options.sandboxMode) args.push("-c", `sandbox_mode="${options.sandboxMode}"`);
    // Quoted: `-c` takes TOML, and a bare word is not a valid TOML string.
    if (options.reasoning) args.push("-c", `model_reasoning_effort="${options.reasoning.effort}"`);
    if (options.images) {
      for (const f of options.images) {
        args.push("-i", f);
      }
    }
    // Thread id is the positional SESSION_ID and must come after the flags.
    args.push(options.resumeThreadId);
    return args;
  }
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];
  if (options.model) args.push("--model", options.model);
  if (options.sandboxMode) args.push("--sandbox", options.sandboxMode);
  if (options.reasoning) args.push("-c", `model_reasoning_effort="${options.reasoning.effort}"`);
  if (options.addDirs) {
    for (const dir of options.addDirs) {
      args.push("-C", dir);
    }
  }
  if (options.images) {
    for (const f of options.images) {
      args.push("-i", f);
    }
  }
  return args;
}

export interface CodexLaunch {
  /** Binary to spawn — host node when the install is a shim, else the executable itself. */
  command: string;
  /** Argv prefix before the codex args (the resolved script when shimmed). */
  prependArgs: string[];
  /** Extra env to merge (e.g. harvested NODE_PATH); undefined means inherit. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve how to actually spawn codex. npm-shim-only installs (win32,
 * no native exe) cannot run via `spawn(shim, {shell:false})` (EINVAL),
 * so the shim is resolved to its node script and launched with the host
 * node — the same pattern the `.cmd` itself uses (`node codex.js ...`).
 */
export function resolveCodexLaunch(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): CodexLaunch {
  if (platform === "win32") {
    const shim = resolveShimTarget(executable, platform);
    if (shim) {
      return {
        command: process.execPath,
        prependArgs: [shim.script],
        env: shim.env ? { ...process.env, ...shim.env } : undefined,
      };
    }
  }
  return { command: executable, prependArgs: [] };
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
