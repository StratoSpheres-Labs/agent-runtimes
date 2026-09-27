import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { DefaultRun, type AgentRun } from "../../src/core/run.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import { buildOpencodeArgs, buildOpencodeMcpConfig } from "./definition.js";
import { OpencodeParser } from "./parser.js";
import { opencodeDefinition } from "./definition.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { PromptContent } from "../../src/definition/content.js";
import { splitPromptContent } from "../../src/definition/content.js";
import { isKnownModel } from "../../src/discovery/models.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { HistoryOptions, TranscriptEntry } from "../../src/definition/transcript.js";
import { readOpencodeTranscript } from "./transcript.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { stageImageToTempFile, stagedIsTemp } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
import { NativeIdResumeGuard } from "../../src/core/resume-guard.js";
import { sanitizeResumeId } from "../../src/definition/session-inputs.js";
import { buildAgentEnv } from "../../src/discovery/env.js";
import { resolveLaunch } from "../../src/discovery/launch.js";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 15 鈥?Opencode session with resume
 * Captures native opencode sessionID from `session_started` and reuses it via `--session`.
 */
export class OpencodeSession implements AgentSession {
  public readonly id: string;
  private readonly inner: DefaultSession;
  private opencodeSessionId: string | null = null;
  private readonly command: string;
  private readonly cwd: string | undefined;
  private readonly model: string | undefined;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly agent: string | undefined;
  public readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly stagedImages: string[] = [];
  private readonly resumeGuard = new NativeIdResumeGuard();

  public constructor(options: {
    id: string;
    command: string;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    agent?: string;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    resumeSessionId?: string;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.agent = options.agent;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.opencodeSessionId = sanitizeResumeId(options.resumeSessionId, "opencode") ?? null;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: PromptContent, runOpts: SessionRunOptions): AgentRun {
    this.resumeGuard.noteRunCreated();
    // No mid-run channel: stdin carries one prompt per process.
    if (runOpts.allowMidRunInput === true) {
      throw new RuntimeSessionError(
        "opencode runs do not support mid-run input (send): stdin carries one prompt per process",
        { runtime: "opencode" },
      );
    }
    const { text, images: partImages } = splitPromptContent(prompt);
    // Per-run overrides fall back to the session values; an id unknown to
    // the primed catalog rejects before anything spawns (fail-open when
    // the catalog was never surfaced).
    const model = runOpts.model ?? this.model;
    if (
      model !== undefined &&
      !isKnownModel("opencode", model, opencodeDefinition.models?.fallbackModels ?? [])
    ) {
      throw new RuntimeSessionError(
        `unknown model "${model}" for opencode — not in the live catalog or fallback list`,
        { runtime: "opencode" },
      );
    }
    const reasoning = runOpts.reasoning ?? this.reasoning;
    const dir = this.cwd ? resolve(this.cwd) : undefined;
    const baseArgs = this.opencodeSessionId
      ? buildOpencodeArgs({
          model,
          sessionId: this.opencodeSessionId,
          reasoning,
          agent: this.agent,
          format: "json",
          dir,
        })
      : buildOpencodeArgs({ model, reasoning, agent: this.agent, format: "json", dir });
    const allImages = [...partImages, ...(runOpts.images ?? [])];
    const imageFiles = allImages.map((img) => {
      const file = stageImageToTempFile(img, this.cwd);
      if (stagedIsTemp(file, this.cwd)) this.stagedImages.push(file);
      return file;
    });
    const args = [...baseArgs, ...imageFiles.flatMap((f) => ["-f", f])];
    // Shim-aware spawn (win32 npm `.cmd` needs host node); native binaries
    // pass through untouched. Launch env seeds the agent env merge.
    const launch = resolveLaunch(this.command || opencodeDefinition.executable.command);
    const baseEnv = launch.env ?? process.env;
    // MCP travels via env (no CLI flag): merge over the ambient env 鈥?    // spawn replaces (never merges), so spreading process.env is required.
    const mcpConfig =
      this.mcpServers && this.mcpServers.length > 0
        ? buildOpencodeMcpConfig(this.mcpServers)
        : undefined;
    const env = mcpConfig
      ? buildAgentEnv("opencode", baseEnv, { OPENCODE_CONFIG_CONTENT: mcpConfig })
      : buildAgentEnv("opencode", baseEnv);
    const run = new DefaultRun(runId, {
      command: launch.command,
      args: [...launch.prependArgs, ...args],
      cwd: this.cwd,
      stdinData: text,
      env: Object.keys(env).length > 0 ? env : undefined,
      timeout: runOpts.timeout,
      parser: new OpencodeParser(),
    });
    // Wrap events to capture native session id
    const origEvents = run.events.bind(run);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    run.events = function () {
      return (async function* () {
        for await (const e of origEvents()) {
          self.resumeGuard.noteEvent(e.type, self.opencodeSessionId !== null);
          if (e.type === "session_started") {
            const sid = (e as { sessionId: string }).sessionId;
            self.opencodeSessionId = sid;
            try {
              saveSessionRecord({
                id: self.id,
                nativeId: sid,
                cwd: self.cwd ?? process.cwd(),
                model: self.model,
                updatedAt: Date.now(),
              });
            } catch (_e: unknown) {
              String(_e);
            }
          }
          yield e;
        }
      })();
    };
    return run;
  }

  public async run(prompt: PromptContent, options?: SessionRunOptions): Promise<AgentRun> {
    this.resumeGuard.assertCanStartRun(this.opencodeSessionId, this.id, "opencode");
    return this.inner.run(prompt, options);
  }

  public async history(options?: HistoryOptions): Promise<TranscriptEntry[]> {
    // No successful run yet → no native id → no transcript (not an error).
    if (!this.opencodeSessionId) return [];
    return readOpencodeTranscript({ sessionId: this.opencodeSessionId, ...options });
  }

  public async resume(): Promise<void> {
    // No-op: next run will automatically use captured opencodeSessionId
    // Throws if never had a successful run (no native id yet) 鈥?let caller decide
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
    return this.inner.close();
  }

  /** For testing: expose captured native id */
  public get nativeSessionId(): string | null {
    return this.opencodeSessionId;
  }
}
