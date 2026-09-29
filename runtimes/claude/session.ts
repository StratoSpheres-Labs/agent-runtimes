import { rmSync } from "node:fs";
import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { type AgentRun } from "../../src/core/run.js";
import type { RuntimeEvent } from "../../src/events/runtime-event.js";
import { ClaudeRun } from "./run.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import {
  buildClaudeArgs,
  buildClaudeMcpAllowedTools,
  buildClaudeStdinPrompt,
  mergeClaudeAllowedTools,
  writeClaudeMcpConfigFile,
} from "./definition.js";
import { ClaudeParser } from "./parser.js";
import { claudeDefinition } from "./definition.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { PromptContent } from "../../src/definition/content.js";
import { splitPromptContent } from "../../src/definition/content.js";
import { isKnownModel } from "../../src/discovery/models.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { normalizeWorkspaceAllowedPaths } from "../../src/definition/workspace.js";
import type { PermissionHandler } from "../../src/definition/permission.js";
import type { HistoryOptions, TranscriptEntry } from "../../src/definition/transcript.js";
import { readClaudeTranscript } from "./transcript.js";
import { imageToBase64 } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
import { silentLogger, type RuntimeLogger } from "../../src/definition/logger.js";
import { NativeIdResumeGuard } from "../../src/core/resume-guard.js";
import { sanitizeResumeId } from "../../src/definition/session-inputs.js";
import { buildAgentEnv } from "../../src/discovery/env.js";
import { resolveLaunch } from "../../src/discovery/launch.js";

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
  private readonly agent: string | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly maxBudgetUsd: number | undefined;
  private readonly outputSchema: string | undefined;
  public readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly allowedTools: string[] | undefined;
  private readonly onPermissionRequest: PermissionHandler | undefined;
  private mcpConfigFile: string | null = null;
  private readonly resumeGuard = new NativeIdResumeGuard();
  private readonly log: RuntimeLogger;

  public constructor(options: {
    id: string;
    command: string;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    agent?: string;
    systemPrompt?: string;
    maxBudgetUsd?: number;
    outputSchema?: string;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    allowedTools?: string[];
    resumeSessionId?: string;
    onPermissionRequest?: PermissionHandler;
    logger?: RuntimeLogger;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.agent = options.agent;
    this.systemPrompt = options.systemPrompt;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.outputSchema = options.outputSchema;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.allowedTools = options.allowedTools;
    this.claudeSessionId = sanitizeResumeId(options.resumeSessionId, "claude") ?? null;
    this.onPermissionRequest = options.onPermissionRequest;
    this.log = options.logger ?? silentLogger;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      logger: this.log,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: PromptContent, runOpts: SessionRunOptions): AgentRun {
    // NOTE: no argv prompt 鈥?stream-json input reads stdin only.
    // MCP sessions pre-approve exactly their own servers' tools so headless
    // turns can call them (least privilege 鈥?no bypassPermissions).
    this.resumeGuard.noteRunCreated();
    // No mid-run channel: print mode consumes only the initial stdin
    // prompt (verified live — follow-up envelopes are never processed).
    if (runOpts.allowMidRunInput === true) {
      throw new RuntimeSessionError(
        "claude runs do not support mid-run input (send): print mode consumes only the initial stdin prompt",
        { runtime: "claude" },
      );
    }
    const mcpServers =
      this.mcpServers !== undefined && this.mcpServers.length > 0 ? this.mcpServers : undefined;
    const { text, images: partImages } = splitPromptContent(prompt);
    const model = runOpts.model ?? this.model;
    if (
      model !== undefined &&
      !isKnownModel("claude", model, claudeDefinition.models?.fallbackModels ?? [])
    ) {
      throw new RuntimeSessionError(
        `unknown model "${model}" for claude — not in the live catalog or fallback list`,
        { runtime: "claude" },
      );
    }
    const reasoning = runOpts.reasoning ?? this.reasoning;
    const allowedPaths = normalizeWorkspaceAllowedPaths(this.workspace?.allowedPaths, this.cwd);
    const allImages = [...partImages, ...(runOpts.images ?? [])];
    const images = allImages.map((img) => imageToBase64(img, this.cwd));
    const base = {
      model,
      reasoning,
      agent: this.agent,
      systemPrompt: this.systemPrompt,
      maxBudgetUsd: this.maxBudgetUsd,
      outputSchema: this.outputSchema,
      addDirs: allowedPaths.length > 0 ? allowedPaths : undefined,
      permissionMode: this.workspace?.permissionMode,
      dangerouslySkipPermissions: this.workspace?.dangerouslySkipPermissions,
      mcpConfigFile: this.ensureMcpConfig(),
      allowedTools: mergeClaudeAllowedTools(
        this.allowedTools,
        mcpServers ? buildClaudeMcpAllowedTools(mcpServers) : undefined,
      ),
    };
    const args = this.claudeSessionId
      ? buildClaudeArgs({ ...base, resumeId: this.claudeSessionId })
      : buildClaudeArgs(base);
    // Shim-aware spawn (win32 npm `.cmd` needs host node); native binaries
    // pass through untouched. Full agent-env hardening (backfills, toolchain
    // PATH, proxy normalization) like every other adapter.
    const launch = resolveLaunch(this.command || claudeDefinition.executable.command);
    const run = new ClaudeRun(runId, {
      command: launch.command,
      args: [...launch.prependArgs, ...args],
      cwd: this.cwd,
      env: buildAgentEnv("claude", launch.env ?? process.env),
      stdinData: buildClaudeStdinPrompt(text, images.length > 0 ? images : undefined),
      timeout: runOpts.timeout,
      parser: new ClaudeParser(),
      keepStdinOpen: this.onPermissionRequest !== undefined,
      logger: this.log,
      journalSessionId: this.id,
    });
    // Wrap events to capture native session id and handle permission requests
    const origEvents = run.events.bind(run);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    run.events = function () {
      return (async function* () {
        for await (const e of origEvents()) {
          self.resumeGuard.noteEvent(e.type, self.claudeSessionId !== null);
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
            } catch (err: unknown) {
              // Best-effort persistence — warn, never fail the turn.
              self.log.warn("session-record-save-failed", {
                sessionId: self.id,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (e.type === "permission_request" && self.onPermissionRequest) {
            const req = e as {
              id: string;
              toolName?: string;
              prompt?: string;
              options: Array<{ optionId: string; kind: string; label?: string }>;
              raw?: unknown;
            };
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
            } catch (err: unknown) {
              // W5: a failed answer must be visible — otherwise the caller
              // believes they answered while the turn stalls. The request
              // itself is still yielded below so the consumer sees both.
              const message = err instanceof Error ? err.message : String(err);
              const failed: RuntimeEvent = {
                type: "error",
                error: { code: "PERMISSION_ANSWER_FAILED", message },
              };
              yield failed;
            }
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

  public async run(prompt: PromptContent, options?: SessionRunOptions): Promise<AgentRun> {
    this.resumeGuard.assertCanStartRun(this.claudeSessionId, this.id, "claude");
    return this.inner.run(prompt, options);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async history(options?: HistoryOptions): Promise<TranscriptEntry[]> {
    if (!this.claudeSessionId) return [];
    return readClaudeTranscript({ sessionId: this.claudeSessionId, cwd: this.cwd, ...options });
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
