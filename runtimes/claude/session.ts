import { rmSync } from "node:fs";
import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { DefaultRun, type AgentRun } from "../../src/core/run.js";
import {
  buildClaudeArgs,
  buildClaudeMcpAllowedTools,
  buildClaudeStdinPrompt,
  writeClaudeMcpConfigFile,
} from "./definition.js";
import { ClaudeParser } from "./parser.js";
import { claudeDefinition } from "./definition.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { normalizeWorkspaceAllowedPaths } from "../../src/definition/workspace.js";
import type { PermissionHandler } from "../../src/definition/permission.js";
import { imageToBase64 } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";

/**
 * Claude session with resume 鈥?mirrors OpencodeSession (Phase 15).
 * Captures the native session id from `system/init` (`session_started`)
 * and reuses it via `--resume`. The first run carries no session flags:
 * daemon-minted ids are not valid `--session-id` UUIDs.
 */
export class ClaudeSession implements AgentSession {
  public readonly id: string;
  private readonly inner: DefaultSession;
  private claudeSessionId: string | null = null;
  private readonly command: string;
  private readonly cwd: string | undefined;
  private readonly model: string | undefined;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly onPermissionRequest: PermissionHandler | undefined;
  private mcpConfigFile: string | null = null;

  public constructor(options: {
    id: string;
    command: string;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    resumeSessionId?: string;
    onPermissionRequest?: PermissionHandler;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.claudeSessionId = options.resumeSessionId ?? null;
    this.onPermissionRequest = options.onPermissionRequest;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: string, runOpts: SessionRunOptions): AgentRun {
    // NOTE: no argv prompt 鈥?stream-json input reads stdin only.
    // MCP sessions pre-approve exactly their own servers' tools so headless
    // turns can call them (least privilege 鈥?no bypassPermissions).
    const mcpServers =
      this.mcpServers !== undefined && this.mcpServers.length > 0 ? this.mcpServers : undefined;
    const allowedPaths = normalizeWorkspaceAllowedPaths(this.workspace?.allowedPaths, this.cwd);
    const images = runOpts.images?.map((img) => imageToBase64(img, this.cwd));
    const base = {
      model: this.model,
      reasoning: this.reasoning,
      addDirs: allowedPaths.length > 0 ? allowedPaths : undefined,
      permissionMode: this.workspace?.permissionMode,
      dangerouslySkipPermissions: this.workspace?.dangerouslySkipPermissions,
      mcpConfigFile: this.ensureMcpConfig(),
      allowedTools: mcpServers ? buildClaudeMcpAllowedTools(mcpServers) : undefined,
    };
    const args = this.claudeSessionId
      ? buildClaudeArgs({ ...base, resumeId: this.claudeSessionId })
      : buildClaudeArgs(base);
    const run = new DefaultRun(runId, {
      command: this.command || claudeDefinition.executable.command,
      args,
      cwd: this.cwd,
      stdinData: buildClaudeStdinPrompt(prompt, images),
      timeout: runOpts.timeout,
      parser: new ClaudeParser(),
      keepStdinOpen: this.onPermissionRequest !== undefined,
    });
    // Wrap events to capture native session id and handle permission requests
    const origEvents = run.events.bind(run);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    run.events = function () {
      return (async function* () {
        for await (const e of origEvents()) {
          if (e.type === "session_started") {
            const sid = (e as { sessionId: string }).sessionId;
            self.claudeSessionId = sid;
            try {
              saveSessionRecord({
                id: self.id,
                nativeId: sid,
                cwd: self.cwd ?? process.cwd(),
                model: self.model,
                updatedAt: Date.now(),
              });
            } catch (_e: unknown) { String(_e); }
          }
          if (e.type === "permission_request" && self.onPermissionRequest) {
            const req = e as { id: string; toolName?: string; prompt?: string; options: Array<{ optionId: string; kind: string; label?: string }>; raw?: unknown };
            try {
              const ans = await self.onPermissionRequest({
                method: "AskUserQuestion",
                sessionId: self.claudeSessionId ?? undefined,
                toolName: req.toolName,
                options: req.options,
                raw: req.raw,
              });
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AgentRun optional vs DefaultRun concrete
              if (run.respondToPermission !== undefined) {
                await run.respondToPermission(req.id, ans.optionId);
              }
            } catch (_e: unknown) { String(_e); }
          }
          yield e;
        }
      })();
    };
    return run;
  }

  /**
   * Lazily write the `--mcp-config` temp file on first run (never for
   * sessions without servers). Returns undefined when no MCP is configured.
   */
  private ensureMcpConfig(): string | undefined {
    if (!this.mcpServers || this.mcpServers.length === 0) return undefined;
    if (!this.mcpConfigFile) {
      this.mcpConfigFile = writeClaudeMcpConfigFile(this.mcpServers, this.id);
    }
    return this.mcpConfigFile;
  }

  public async run(prompt: string, options?: SessionRunOptions): Promise<AgentRun> {
    return this.inner.run(prompt, options);
  }

  public async resume(): Promise<void> {
    // No-op: next run will automatically use captured claudeSessionId
    await this.inner.resume();
  }

  public async cancel(): Promise<void> {
    return this.inner.cancel();
  }

  public async close(): Promise<void> {
    if (this.mcpConfigFile) {
      try {
        rmSync(this.mcpConfigFile, { force: true });
      } catch (_e: unknown) {
        String(_e);
      } finally {
        this.mcpConfigFile = null;
      }
    }
    return this.inner.close();
  }

  /** For testing: expose captured native id */
  public get nativeSessionId(): string | null {
    return this.claudeSessionId;
  }
}








