import type { RuntimeDefinition } from "../definition/index.js";
import type { RuntimeCapabilities } from "../definition/capability.js";
import type { VersionPolicy } from "../definition/version.js";
import type { RuntimeModel } from "../definition/model.js";
import type { ReasoningOptions } from "../definition/reasoning.js";
import type { McpServer, McpServerInfo } from "../definition/mcp.js";
import type { RuntimeSkill } from "../definition/skill.js";
import type { RuntimePlugin } from "../definition/plugin.js";
import { findAllInstalls, type InstalledCopy } from "../discovery/installs.js";
import type { AuthStatus } from "../definition/auth.js";
import type { WorkspaceOptions } from "../definition/workspace.js";
import type { PermissionHandler } from "../definition/permission.js";
import type { RuntimeLogger } from "../definition/logger.js";
import type { SeedMessage } from "../definition/session-inputs.js";
import { findExecutable } from "../discovery/executable.js";
import { probeVersion } from "../discovery/version.js";
import { resolveLaunch } from "../discovery/launch.js";
import { probeHelpFlags } from "../discovery/capabilities.js";
import { discoverModels, rememberLiveModels } from "../discovery/models.js";
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
  /** CLI version policy (minimum/tested) — drives version diagnostics. */
  versionPolicy?: VersionPolicy;
  /** npm registry id for update checks — drives the `→ latest` suffix on the doctor Version row. */
  registryId?: string;
}

export interface CreateSessionOptions {
  cwd?: string;
  model?: string;
  reasoning?: ReasoningOptions;
  /**
   * Named agent/persona (opencode `--agent`). Runtimes without an agent
   * channel reject loudly — see `assertSessionInputsSupported`.
   */
  agent?: string;
  /**
   * Caller system prompt (claude `--append-system-prompt`; append, never
   * replace). Runtimes without a channel reject loudly (never silently
   * dropped) — see `assertSessionInputsSupported`.
   */
  systemPrompt?: string;
  /**
   * Output token budget. Reserved: no runtime wires a channel yet, so any
   * value is rejected loudly (never silently dropped).
   */
  maxTokens?: number;
  /**
   * Cost budget in USD (claude `--max-budget-usd`). This is spend, not
   * tokens — the two are never interchangeable. Runtimes without a
   * channel reject loudly (never silently dropped).
   */
  maxBudgetUsd?: number;
  /**
   * JSON Schema constraining the model's final message (codex
   * `--output-schema`, claude `--json-schema`). Object or JSON string;
   * normalized + shape-checked before anything spawns. The text still
   * arrives as `text_delta` — callers `JSON.parse` it. Runtimes without
   * a channel reject loudly (never silently dropped).
   */
  outputSchema?: Record<string, unknown> | string;
  /**
   * Named config profile (codex `-p/--profile`). Runtimes without a
   * profile channel reject loudly.
   */
  profile?: string;
  /**
   * Caller tool allowlist (claude `--allowedTools`, merged with the
   * MCP-derived grants). Runtimes without an allowlist flag reject loudly.
   */
  allowedTools?: string[];
  /**
   * Seed a fresh session with prior turns. Reserved: no runtime has a
   * transcript-injection channel, so any non-empty value is rejected
   * loudly — resume a native session id instead.
   */
  seedMessages?: SeedMessage[];
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
  /**
   * Close the session after this many ms without activity (run start,
   * turn end, queued demand). Undefined/non-positive disables. Long turns
   * in flight re-arm instead of killing active work. Plain data — safe
   * for `WireCreateSessionOptions`.
   */
  idleTimeoutMs?: number;
  /**
   * Diagnostics sink (default silent). Forwarded to the session, its runs,
   * and transports — the embedding app's observability hook. Functions
   * never cross the JSON wire (excluded from `WireCreateSessionOptions`).
   */
  logger?: RuntimeLogger;
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
  /** Phase 33: discover MCP servers known to the agent (config + built-in). */
  mcp(): Promise<McpServerInfo[]>;
  /**
   * Skills metadata known to the agent (read-only, never the body).
   * `cwd` opts into the project-level root (`<cwd>/.opencode/skills`);
   * omitted = global roots only (deterministic, e.g. for doctor).
   */
  skills(options?: { cwd?: string }): Promise<RuntimeSkill[]>;
  /**
   * Plugins declared for the agent (read-only metadata, never file
   * contents). `cwd` opts into the project-level root;
   * omitted = global roots only (deterministic, e.g. for doctor).
   */
  plugins(options?: { cwd?: string }): Promise<RuntimePlugin[]>;
  /**
   * Every installed copy of the CLI on this machine (package manager,
   * version, invocability), grouped by resolved binary. `selected` marks
   * what `detect()` picks. Diagnostic companion to `detect()` — session
   * creation always uses the selected copy.
   */
  installs(): Promise<InstalledCopy[]>;
  /**
   * Probe `command --help` for flag presence (advisory only — feeds the
   * doctor Flags row, never gates arg emission). Never throws: probe
   * failures yield `{}` so callers render no row instead of an error.
   * `executable` overrides the bare definition command (doctor passes the
   * detected absolute path — bare names can miss PATH-less installs).
   */
  probeFlags?(flags: readonly string[], executable?: string): Promise<Record<string, boolean>>;
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
      versionPolicy: this.definition.versionPolicy,
      registryId: this.definition.executable.registryId,
    };
  }

  public capabilities(): RuntimeCapabilities {
    return this.definition.capabilities;
  }

  // NOTE: a `capabilitiesProbed()` refinement used to live here (definition
  // capabilities overlaid with `--help` hits). Removed: zero callers, and
  // the doctor Flags row (`probeFlags()` + `ADVISORY_PROBE_FLAGS`) covers
  // the advisory need with raw hits instead of a merged guess. The
  // `probeHelpFlags` / `capabilitiesFromHelp` primitives stay exported
  // and tested for anyone who needs them.

  public async probeFlags(
    flags: readonly string[],
    executable?: string,
  ): Promise<Record<string, boolean>> {
    const cmd = executable ?? this.definition.executable.command;
    const helpArgs = this.definition.executable.helpArgs ?? ["--help"];
    try {
      return await probeHelpFlags(cmd, flags, helpArgs);
    } catch {
      return {};
    }
  }

  public async models(): Promise<RuntimeModel[]> {
    const fallback = this.definition.models?.fallbackModels ?? [];
    const listCmd = this.definition.models?.listCommand;
    // No list command (e.g. claude has no list-models subcommand): never
    // spawn a guess — `claude models` would run the agent with "models"
    // as the prompt. Return fallback directly.
    if (!listCmd || listCmd.length === 0) {
      if (fallback.length > 0) rememberLiveModels(this.definition.identity.id, fallback);
      return fallback;
    }
    const status = await this.detect();
    const exe = status.installed ? status.executable : this.definition.executable.command;
    const live = await discoverModels(exe, listCmd, fallback);
    if (live.length > 0) rememberLiveModels(this.definition.identity.id, live);
    return live;
  }

  public async detect(): Promise<RuntimeStatus> {
    const cmd = this.definition.executable.command;
    const aliases = this.definition.executable.aliases ?? [];
    const extras = this.definition.executable.extraProbePaths ?? [];
    const executable = await findExecutable(cmd, aliases, extras);
    if (!executable) {
      return { installed: false };
    }
    // Probe via the resolved absolute path for consistency (avoids bare-name PATHEXT drift on Windows)
    const version = await this.probeExecutableVersion(executable);
    return { installed: true, executable, version };
  }

  /**
   * Probe the version of a resolved executable. Shim-aware via the shared
   * launch resolver: npm-shim-only installs (win32 `.cmd`) cannot be spawned
   * directly and go through host node instead. Adapter override seam is
   * retained for CLIs needing more (none do today); core never branches on
   * runtime id (Rule 1).
   */
  protected probeExecutableVersion(executable: string): Promise<string | null> {
    const launch = resolveLaunch(executable);
    const versionArgs = [
      ...launch.prependArgs,
      ...(this.definition.executable.versionArgs ?? ["--version"]),
    ];
    return probeVersion(launch.command, versionArgs, launch.env);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    // Phase 4: real session with definition-aware cwd/env; no agent branching
    const session = new DefaultSession({
      cwd: options?.cwd,
      logger: options?.logger,
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

  // eslint-disable-next-line @typescript-eslint/require-await
  public async mcp(): Promise<McpServerInfo[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async skills(): Promise<RuntimeSkill[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async plugins(): Promise<RuntimePlugin[]> {
    return [];
  }

  public async installs(): Promise<InstalledCopy[]> {
    // Definition-driven, adapter-agnostic: every adapter inherits this
    // (all extend DefaultRuntime), so no per-adapter override is needed.
    const exe = this.definition.executable;
    return findAllInstalls(exe.command, exe.aliases ?? [], {
      extras: exe.extraProbePaths ?? [],
      versionArgs: exe.versionArgs,
    });
  }
}
