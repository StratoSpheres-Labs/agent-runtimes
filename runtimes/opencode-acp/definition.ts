import type { RuntimeDefinition } from "../../src/definition/index.js";
import { opencodeDefinition } from "../opencode/definition.js";

/**
 * OpenCode ACP runtime definition — Phase 20.
 * Same binary as the CLI adapter, but driven through `opencode acp`
 * (JSON-RPC over stdio) instead of `opencode run` (one-shot stdout).
 */
export const opencodeAcpDefinition: RuntimeDefinition = {
  identity: {
    id: "opencode-acp",
    name: "OpenCode (ACP)",
  },
  executable: {
    command: "opencode",
    versionArgs: ["--version"],
  },
  // Prompt travels inside JSON-RPC over stdin (framed), not as raw stdin text.
  input: {
    type: "stdin",
  },
  transport: {
    type: "acp",
  },
  capabilities: {
    streaming: true,
    // Capture-style resume: the durable upstream id is replayed via
    // `session/load` in a fresh process (verified live).
    sessionResume: true,
    // Via session/set_model (verified live against opencode 1.18.27).
    modelSelection: true,
    // No reasoning control channel wired yet.
    reasoning: false,
    images: true,
    workspace: false,
  },
  // Sessions span runs (resume replays the durable id); each run still
  // spawns a fresh `opencode acp` process (Session !== Process).
  session: {
    persistent: true,
  },
  // Same binary, same model catalog — single source of truth.
  models: opencodeDefinition.models,
};

export function buildOpencodeAcpArgs(): string[] {
  return ["acp"];
}
