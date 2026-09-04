import { RuntimeRegistry } from "./core/registry.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import { claudeDefinition } from "../runtimes/claude/definition.js";
import { ClaudeRuntime } from "../runtimes/claude/runtime.js";
import { codexDefinition } from "../runtimes/codex/definition.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import { opencodeAcpDefinition } from "../runtimes/opencode-acp/definition.js";
import { OpencodeAcpRuntime } from "../runtimes/opencode-acp/runtime.js";

/**
 * Phase 18 — pre-registered facade behind `import { runtimes } from "agent-runtimes"`.
 *
 * ```ts
 * const runtime = await runtimes.resolve("opencode"); // OpencodeRuntime, not a stub
 * runtimes.list(); // ["opencode", "claude", "codex", "opencode-acp"]
 * await runtimes.detectAll();
 * ```
 *
 * Each adapter registers a concrete factory, so `resolve()` returns the
 * real adapter class (with its wired `createSession`). Core never branches
 * on id (Rule 1); no execution logic lives in the registry (plan §25).
 */
function createRuntimes(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register(opencodeDefinition, () => new OpencodeRuntime());
  registry.register(claudeDefinition, () => new ClaudeRuntime());
  registry.register(codexDefinition, () => new CodexRuntime());
  registry.register(opencodeAcpDefinition, () => new OpencodeAcpRuntime());
  return registry;
}

export const runtimes: RuntimeRegistry = createRuntimes();
