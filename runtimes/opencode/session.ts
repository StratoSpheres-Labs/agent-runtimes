import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { DefaultRun, type AgentRun } from "../../src/core/run.js";
import { buildOpencodeArgs, buildOpencodeMcpConfig } from "./definition.js";
import { OpencodeParser } from "./parser.js";
import { opencodeDefinition } from "./definition.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { stageImageToTempFile, stagedIsTemp } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
import { buildAgentEnv } from "../../src/discovery/env.js";
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
  private readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly stagedImages: string[] = [];

  public constructor(options: {
    id: string;
    command: string;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    resumeSessionId?: string;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.opencodeSessionId = options.resumeSessionId ?? null;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: string, runOpts: SessionRunOptions): AgentRun {
    const dir = this.cwd ? resolve(this.cwd) : undefined;
    const baseArgs = this.opencodeSessionId
      ? buildOpencodeArgs({
          model: this.model,
          sessionId: this.opencodeSessionId,
          reasoning: this.reasoning,
          format: "json",
          dir,
        })
      : buildOpencodeArgs({ model: this.model, reasoning: this.reasoning, format: "json", dir });
    const imageFiles =
      runOpts.images?.map((img) => {
        const file = stageImageToTempFile(img, this.cwd);
        if (stagedIsTemp(file, this.cwd)) this.stagedImages.push(file);
        return file;
      }) ?? [];
    const args = [...baseArgs, ...imageFiles.flatMap((f) => ["-f", f])];
    // MCP travels via env (no CLI flag): merge over the ambient env 鈥?    // spawn replaces (never merges), so spreading process.env is required.
    const mcpConfig =
      this.mcpServers && this.mcpServers.length > 0
        ? buildOpencodeMcpConfig(this.mcpServers)
        : undefined;
    const env = mcpConfig
      ? buildAgentEnv("opencode", process.env, { OPENCODE_CONFIG_CONTENT: mcpConfig })
      : buildAgentEnv("opencode", process.env);
    const run = new DefaultRun(runId, {
      command: this.command || opencodeDefinition.executable.command,
      args,
      cwd: this.cwd,
      stdinData: prompt,
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
            } catch (_e: unknown) { String(_e); }
          }
          yield e;
        }
      })();
    };
    return run;
  }

  public async run(prompt: string, options?: SessionRunOptions): Promise<AgentRun> {
    return this.inner.run(prompt, options);
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








