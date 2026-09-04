import {
  DefaultSession,
  type AgentSession,
  type SessionRunOptions,
} from "../../src/core/session.js";
import { DefaultRun, type AgentRun } from "../../src/core/run.js";
import { buildCodexArgs } from "./definition.js";
import { CodexParser } from "./parser.js";
import { codexDefinition } from "./definition.js";
import { RuntimeSessionError } from "../../src/core/errors.js";
import type { ReasoningOptions } from "../../src/definition/reasoning.js";
import type { McpServer } from "../../src/definition/mcp.js";
import type { WorkspaceOptions } from "../../src/definition/workspace.js";
import { normalizeWorkspaceAllowedPaths } from "../../src/definition/workspace.js";
import { stageImageToTempFile, stagedIsTemp } from "../../src/definition/image.js";
import { saveSessionRecord } from "../../src/core/session-store.js";
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
  private readonly mcpServers: McpServer[] | undefined;
  private readonly workspace: WorkspaceOptions | undefined;
  private readonly stagedImages: string[] = [];

  public constructor(options: {
    id: string;
    command: string;
    prependArgs?: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
    model?: string;
    reasoning?: ReasoningOptions;
    mcpServers?: McpServer[];
    workspace?: WorkspaceOptions;
    resumeSessionId?: string;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.prependArgs = options.prependArgs ?? [];
    this.env = options.env;
    this.cwd = options.cwd;
    this.model = options.model;
    this.reasoning = options.reasoning;
    this.mcpServers = options.mcpServers;
    this.workspace = options.workspace;
    this.codexThreadId = options.resumeSessionId ?? null;
    this.inner = new DefaultSession({
      id: options.id,
      cwd: options.cwd,
      runFactory: (runId, prompt, runOpts) => this.createRun(runId, prompt, runOpts),
    });
  }

  private createRun(runId: string, prompt: string, runOpts: SessionRunOptions): AgentRun {
    // Phase 21: the codex CLI has no MCP wiring 鈥?fail loudly instead of
    // silently dropping the caller's servers (never ignore mcpServers).
    if (this.mcpServers !== undefined && this.mcpServers.length > 0) {
      throw new RuntimeSessionError(
        "codex sessions do not support MCP servers: mcpServers was provided but the codex CLI has no MCP wiring",
        { runtime: "codex" },
      );
    }
    const imageFiles =
      runOpts.images?.map((img) => {
        const file = stageImageToTempFile(img, this.cwd);
        if (stagedIsTemp(file, this.cwd)) this.stagedImages.push(file);
        return file;
      }) ?? [];
    const args = [
      ...this.prependArgs,
      ...buildCodexArgs({
        model: this.model,
        reasoning: this.reasoning,
        resumeThreadId: this.codexThreadId ?? undefined,
        addDirs: normalizeWorkspaceAllowedPaths(this.workspace?.allowedPaths, this.cwd),
        sandboxMode: this.workspace?.sandboxMode,
        images: imageFiles.length > 0 ? imageFiles : undefined,
      }),
    ];
    const env = buildAgentEnv("codex", process.env, this.env);
    const run = new DefaultRun(runId, {
      command: this.command || codexDefinition.executable.command,
      args,
      cwd: this.cwd,
      stdinData: prompt,
      env,
      timeout: runOpts.timeout,
      parser: new CodexParser(),
    });
    // Wrap events to capture native thread id
    const origEvents = run.events.bind(run);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    run.events = function () {
      return (async function* () {
        for await (const e of origEvents()) {
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
    return this.inner.close();
  }

  /** For testing: expose captured native id */
  public get nativeSessionId(): string | null {
    return this.codexThreadId;
  }
}








