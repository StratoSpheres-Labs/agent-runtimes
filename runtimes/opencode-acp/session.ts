import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import type { AgentRun } from "../../src/core/run.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import type { PermissionHandler } from "../../src/definition/permission.js";
import type { HistoryOptions, TranscriptEntry } from "../../src/definition/transcript.js";
import { readOpencodeTranscript } from "../opencode/transcript.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
import { buildAgentEnv } from "../../src/discovery/env.js";
import { resolveLaunch } from "../../src/discovery/launch.js";
import { AcpTransport } from "../../src/transport/acp.js";
import { AcpRun } from "../../src/core/acp-run.js";

/**
 * OpenCode ACP session with resume 鈥?mirrors OpencodeSession (Phase 15).
 * Captures the native ACP session id from the first run and replays it
 * via `session/load` on subsequent runs. Each run still spawns a FRESH
 * `opencode acp` process; only the durable upstream id persists
 * (Session !== Process). A stale id rejects loudly 鈥?never silently
 * falls back to a fresh session.
 */
export class OpencodeAcpSession implements AgentSession {
  public readonly id: string;
  private readonly inner: DefaultSession;
  private acpSessionId: string | null = null;
  private readonly command: string;
  private readonly cwd: string;
  private readonly model: string | undefined;
  public readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly onPermissionRequest: PermissionHandler | undefined;

  public constructor(options: {
    id: string;
    command: string;
    cwd: string;
    model?: string;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    onPermissionRequest?: PermissionHandler;
    resumeSessionId?: string;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.onPermissionRequest = options.onPermissionRequest;
    this.acpSessionId = options.resumeSessionId ?? null;
    // NOTE: no reasoning passthrough 鈥?capabilities.reasoning is false
    // (no control channel wired); CreateSessionOptions.reasoning is
    // intentionally not forwarded.
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      runFactory: async (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private async createRun(
    runId: string,
    prompt: string,
    runOpts: SessionRunOptions,
  ): Promise<AgentRun> {
    // Shim-aware spawn (win32 npm `.cmd` needs host node); native binaries
    // pass through untouched. Launch env seeds the agent env merge.
    const launch = resolveLaunch(this.command);
    const env = buildAgentEnv("opencode-acp", launch.env ?? process.env);
    const transport = new AcpTransport({
      command: launch.command,
      args: [...launch.prependArgs, "acp"],
      cwd: this.cwd,
      env,
    });
    const run = new AcpRun(runId, {
      transport,
      cwd: this.cwd,
      model: this.model,
      mcpServers: this.mcpServers,
      onPermissionRequest: this.onPermissionRequest,
      images: runOpts.images,
      timeoutMs: runOpts.timeout,
      resumeSessionId: this.acpSessionId ?? undefined,
    });
    await run.start(prompt);
    // start() resolves only after a successful handshake, so the native id
    // is always available here 鈥?no event snooping needed.
    const native = run.nativeSessionId;
    if (native) {
      this.acpSessionId = native;
      try {
        saveSessionRecord({
          id: this.id,
          nativeId: native,
          cwd: this.cwd,
          model: this.model,
          updatedAt: Date.now(),
        });
      } catch (_e: unknown) {
        String(_e);
      }
    }
    return run;
  }

  public async run(prompt: string, options?: SessionRunOptions): Promise<AgentRun> {
    return this.inner.run(prompt, options);
  }

  public async history(options?: HistoryOptions): Promise<TranscriptEntry[]> {
    // ACP turns share opencode's store when the native id is an opencode
    // session id; anything else misses and fails open to [].
    if (!this.acpSessionId) return [];
    return readOpencodeTranscript({ sessionId: this.acpSessionId, ...options });
  }

  public async resume(): Promise<void> {
    // No-op: next run automatically replays the captured id.
    await this.inner.resume();
  }

  public async cancel(): Promise<void> {
    return this.inner.cancel();
  }

  public async close(): Promise<void> {
    return this.inner.close();
  }

  /** For testing: expose captured native id */
  public get nativeSessionId(): string | null {
    return this.acpSessionId;
  }
}
