import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { DefaultRun, type AgentRun } from "../../src/core/run.js";
import { buildCodexArgs, writeCodexSchemaFile } from "./definition.js";
import { CodexParser } from "./parser.js";
import { codexDefinition } from "./definition.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import { resolve } from "node:path";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { PromptContent } from "../../src/definition/content.js";
import { splitPromptContent } from "../../src/definition/content.js";
import { isKnownModel } from "../../src/discovery/models.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { HistoryOptions, TranscriptEntry } from "../../src/definition/transcript.js";
import { readCodexTranscript } from "./transcript.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { normalizeWorkspaceAllowedPaths } from "../../src/definition/workspace.js";
import { stageImageToTempFile, stagedIsTemp } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
import { silentLogger, type RuntimeLogger } from "../../src/definition/logger.js";
import { NativeIdResumeGuard } from "../../src/core/resume-guard.js";
import { sanitizeResumeId } from "../../src/definition/session-inputs.js";
import { buildAgentEnv } from "../../src/discovery/env.js";
import { rmSync } from "node:fs";

/**
 * Codex session with resume 鈥?mirrors OpencodeSession (Phase 15).
 * Captures the native thread id from `thread.started` (`session_started`)
 * and reuses it via `exec resume <thread_id>` (flags-first form; see
 * buildCodexArgs). Codex mints its own id, so the first run carries no
 * session flags.
 */
export class CodexSession implements AgentSession {
  public readonly id: string;
  private readonly inner: DefaultSession;
  private codexThreadId: string | null = null;
  private readonly command: string;
  private readonly prependArgs: string[];
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly cwd: string | undefined;
  private readonly model: string | undefined;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly profile: string | undefined;
  private readonly outputSchema: string | undefined;
  public readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly stagedImages: string[] = [];
  private schemaConfigFile: string | null = null;
  private readonly resumeGuard = new NativeIdResumeGuard();
  private readonly log: RuntimeLogger;

  public constructor(options: {
    id: string;
    command: string;
    prependArgs?: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    profile?: string;
    outputSchema?: string;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    resumeSessionId?: string;
    logger?: RuntimeLogger;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.prependArgs = options.prependArgs ?? [];
    this.env = options.env;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.profile = options.profile;
    this.outputSchema = options.outputSchema;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.codexThreadId = sanitizeResumeId(options.resumeSessionId, "codex") ?? null;
    this.log = options.logger ?? silentLogger;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      logger: this.log,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: PromptContent, runOpts: SessionRunOptions): AgentRun {
    this.resumeGuard.noteRunCreated();
    // Phase 21: the codex CLI has no MCP wiring — fail loudly instead of
    // silently dropping the caller's servers (never ignore mcpServers).
    if (this.mcpServers !== undefined && this.mcpServers.length > 0) {
      throw new RuntimeSessionError(
        "codex sessions do not support MCP servers: mcpServers was provided but the codex CLI has no MCP wiring",
        { runtime: "codex" },
      );
    }
    // No mid-run channel: stdin carries one prompt per exec.
    if (runOpts.allowMidRunInput === true) {
      throw new RuntimeSessionError(
        "codex runs do not support mid-run input (send): stdin carries one prompt per exec",
        { runtime: "codex" },
      );
    }
    const { text, images: partImages } = splitPromptContent(prompt);
    const model = runOpts.model ?? this.model;
    if (
      model !== undefined &&
      !isKnownModel("codex", model, codexDefinition.models?.fallbackModels ?? [])
    ) {
      throw new RuntimeSessionError(
        `unknown model "${model}" for codex — not in the live catalog or fallback list`,
        { runtime: "codex" },
      );
    }
    const reasoning = runOpts.reasoning ?? this.reasoning;
    const allImages = [...partImages, ...(runOpts.images ?? [])];
    const imageFiles = allImages.map((img) => {
      const file = stageImageToTempFile(img, this.cwd);
      if (stagedIsTemp(file, this.cwd)) this.stagedImages.push(file);
      return file;
    });
    // cwd / addDirs / profile / approveForMe are create-only
    // (`exec resume` rejects them): a resumed thread carries the
    // dirs/profile/review mode granted at creation.
    const createOnly =
      this.codexThreadId !== null
        ? { cwd: undefined, addDirs: undefined, profile: undefined, approveForMe: undefined }
        : {
            cwd: this.cwd ? resolve(this.cwd) : undefined,
            addDirs: normalizeWorkspaceAllowedPaths(this.workspace?.allowedPaths, this.cwd),
            profile: this.profile,
            approveForMe: this.workspace?.autoReview,
          };
    const args = [
      ...this.prependArgs,
      ...buildCodexArgs({
        model,
        reasoning,
        resumeThreadId: this.codexThreadId ?? undefined,
        cwd: createOnly.cwd,
        addDirs: createOnly.addDirs,
        sandboxMode: this.workspace?.sandboxMode,
        dangerouslySkipPermissions: this.workspace?.dangerouslySkipPermissions,
        approveForMe: createOnly.approveForMe,
        profile: createOnly.profile,
        outputSchemaFile: this.ensureSchemaFile(),
        images: imageFiles.length > 0 ? imageFiles : undefined,
      }),
    ];
    const env = buildAgentEnv("codex", process.env, this.env);
    const run = new DefaultRun(runId, {
      command: this.command || codexDefinition.executable.command,
      args,
      cwd: this.cwd,
      stdinData: text,
      env,
      timeout: runOpts.timeout,
      parser: new CodexParser(),
      logger: this.log,
      journalSessionId: this.id,
    });
    // Wrap events to capture native thread id
    const origEvents = run.events.bind(run);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    run.events = function () {
      return (async function* () {
        for await (const e of origEvents()) {
          self.resumeGuard.noteEvent(e.type, self.codexThreadId !== null);
          if (e.type === "session_started") {
            const sid = (e as { sessionId: string }).sessionId;
            self.codexThreadId = sid;
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
          yield e;
        }
      })();
    };
    return run;
  }

  /**
   * Lazily stage the `--output-schema` temp file on first run (never for
   * sessions without a schema). Returns undefined when no schema was
   * configured. The file is deleted on close.
   */
  private ensureSchemaFile(): string | undefined {
    if (!this.outputSchema) return undefined;
    if (!this.schemaConfigFile) {
      this.schemaConfigFile = writeCodexSchemaFile(this.outputSchema, this.id);
    }
    return this.schemaConfigFile;
  }

  public async run(prompt: PromptContent, options?: SessionRunOptions): Promise<AgentRun> {
    this.resumeGuard.assertCanStartRun(this.codexThreadId, this.id, "codex", "thread");
    return this.inner.run(prompt, options);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async history(options?: HistoryOptions): Promise<TranscriptEntry[]> {
    if (!this.codexThreadId) return [];
    return readCodexTranscript({ sessionId: this.codexThreadId, ...options });
  }

  public async resume(): Promise<void> {
    // No-op: next run will automatically use captured codexThreadId
    await this.inner.resume();
  }

  public async cancel(): Promise<void> {
    return this.inner.cancel();
  }

  public async close(): Promise<void> {
    for (const f of this.stagedImages.splice(0)) {
      try {
        rmSync(f, { force: true });
      } catch (_e: unknown) {
        String(_e);
      }
    }
    if (this.schemaConfigFile) {
      try {
        rmSync(this.schemaConfigFile, { force: true });
      } catch (_e: unknown) {
        String(_e);
      } finally {
        this.schemaConfigFile = null;
      }
    }
    return this.inner.close();
  }

  /** For testing: expose captured native id */
  public get nativeSessionId(): string | null {
    return this.codexThreadId;
  }
}
