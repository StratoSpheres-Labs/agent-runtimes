import type { RuntimeDefinition } from "../definition/index.js";
import type { RuntimeCapabilities } from "../definition/capability.js";
import type { RuntimeModel } from "../definition/model.js";
import type { ReasoningOptions } from "../definition/reasoning.js";
import type { McpServer } from "../definition/mcp.js";
import type { AuthStatus } from "../definition/auth.js";
import type { WorkspaceOptions } from "../definition/workspace.js";
import type { PermissionHandler } from "../definition/permission.js";
import { findExecutable } from "../discovery/executable.js";
import { probeVersion } from "../discovery/version.js";
import { probeHelpFlags, capabilitiesFromHelp } from "../discovery/capabilities.js";
import { discoverModels } from "../discovery/models.js";
import { DefaultSession, type AgentSession } from "./session.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuntimeStatus =
  { installed: true; executable: string; version: string | null } | { installed: false };

export interface RuntimeInfo {
  id: string;
  name: string;
  description?: string;
  capabilities: RuntimeCapabilities;
}

export interface CreateSessionOptions {
  cwd?: string;
  model?: string;
  reasoning?: ReasoningOptions;
  /**
   * Stdio MCP servers for the session (Phase 21). Adapters that support
   * MCP translate this into their native wiring; adapters without support
   * (codex) reject loudly instead of silently ignoring it.
   */
  mcpServers?: McpServer[];
  /**
   * Workspace constraints (Phase 23) — agent-agnostic allowlist /
   * permission / sandbox gating. Each adapter maps this to its native
   * flags (`--add-dir`, `-C`, `--sandbox`, `--permission-mode`).
   */
  workspace?: WorkspaceOptions;
  /**
   * Permission handler for ACP-style `agent → client` requests
   * (Phase 24). Only ACP sessions use it today; CLI runtimes ignore it
   * (they use `--permission-mode`/`--sandbox` via `workspace`).
   * When absent the transport answers `-32601` (never stall).
   */
  onPermissionRequest?: PermissionHandler;
  /** Phase 27: resume a durable native session (capture-style). */
  resumeSessionId?: string;
}

// Re-export session/run types for Phase 4 wiring
export type { AgentSession } from "./session.js";

// ---------------------------------------------------------------------------
// AgentRuntime interface (Task 2.1)
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  readonly id: string;
  info(): RuntimeInfo;
  detect(): Promise<RuntimeStatus>;
  createSession(options?: CreateSessionOptions): Promise<AgentSession>;
  capabilities(): RuntimeCapabilities;
  models(): Promise<RuntimeModel[]>;
  /** Phase 22: auth detection (never interactive login). */
  auth(): Promise<AuthStatus>;
}

// ---------------------------------------------------------------------------
// Concrete adapter-agnostic runtime
// ---------------------------------------------------------------------------

export class DefaultRuntime implements AgentRuntime {
  public readonly id: string;
  private readonly definition: RuntimeDefinition;

  public constructor(definition: RuntimeDefinition) {
    this.definition = definition;
    this.id = definition.identity.id;
  }

  public info(): RuntimeInfo {
    return {
      id: this.definition.identity.id,
      name: this.definition.identity.name,
      description: this.definition.identity.description,
      capabilities: this.definition.capabilities,
    };
  }

  public capabilities(): RuntimeCapabilities {
    return this.definition.capabilities;
  }

  public async capabilitiesProbed(): Promise<RuntimeCapabilities> {
    const cmd = this.definition.executable.command;
    const base = this.definition.capabilities;
    const help = await probeHelpFlags(cmd, [
      "--resume",
      "--session",
      "resume",
      "--model",
      "--output-format stream-json",
      "--add-dir",
      "--dir",
      "--permission-mode",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "--sandbox",
      "-C",
    ]);
    return capabilitiesFromHelp(base, help);
  }

  public async models(): Promise<RuntimeModel[]> {
    const fallback = this.definition.models?.fallbackModels ?? [];
    const listCmd = this.definition.models?.listCommand;
    // No list command (e.g. claude has no list-models subcommand): never
    // spawn a guess — `claude models` would run the agent with "models"
    // as the prompt. Return fallback directly.
    if (!listCmd || listCmd.length === 0) return fallback;
    const status = await this.detect();
    const exe = status.installed ? status.executable : this.definition.executable.command;
    return discoverModels(exe, listCmd, fallback);
  }

  public async detect(): Promise<RuntimeStatus> {
    const cmd = this.definition.executable.command;
    const aliases = this.definition.executable.aliases ?? [];
    const executable = await findExecutable(cmd, aliases);
    if (!executable) {
      return { installed: false };
    }
    const versionArgs = this.definition.executable.versionArgs ?? ["--version"];
    // Probe via the resolved absolute path for consistency (avoids bare-name PATHEXT drift on Windows)
    const version = await probeVersion(executable, versionArgs);
    return { installed: true, executable, version };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    // Phase 4: real session with definition-aware cwd/env; no agent branching
    const session = new DefaultSession({
      cwd: options?.cwd,
      // model/env wiring deferred to adapter buildArgs (Phase 9)
    });
    return session;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async auth(): Promise<AuthStatus> {
    // Generic stub performs no probe — adapters override with native checks.
    return {
      authenticated: false,
      method: "unknown",
      detail: "generic runtime stub performs no auth probe",
    };
  }
}
