import { resolve } from "node:path";
import { EventStream } from "../events/event-stream.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ProcessExit } from "./lifecycle.js";
import { RuntimeProtocolError, RuntimeTimeoutError } from "./errors.js";
import { type AcpTransport, buildAcpMcpServers } from "../transport/acp.js";
import type { McpServer } from "../definition/mcp.js";
import type { PermissionHandler, PermissionRequest } from "../definition/permission.js";
import type { ImageInput } from "../definition/image.js";
import { imageToBase64 } from "../definition/image.js";
import { AcpParser } from "../parser/acp.js";
import type { AgentRun } from "./run.js";

export interface AcpRunOptions {
  transport: AcpTransport;
  parser?: AcpParser;
  /** Working directory — resolved absolute for session/new. */
  cwd: string;
  /** Optional model id, applied via session/set_model (verified live). */
  model?: string;
  /**
   * Stdio MCP servers, sent as `mcpServers[]` in `session/new` and
   * `session/load` (both calls are strict: all params mandatory).
   */
  mcpServers?: McpServer[];
  /**
   * Resume handle from a previous run (capture-style resume, verified live:
   * `session/load {sessionId, cwd, mcpServers: []}`). Absent = fresh session.
   * A stale id rejects loudly — never silently fall back to a fresh session.
   */
  resumeSessionId?: string;
  /** Turn timeout for session/prompt. Defaults to 120s. */
  timeoutMs?: number;
  /** Phase 24: delegate `session/request_permission` to the caller. */
  onPermissionRequest?: PermissionHandler;
  /** Phase 26: images for this turn (prompt-attached). */
  images?: ImageInput[];
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const CANCEL_RPC_TIMEOUT_MS = 5_000;

/**
 * A single ACP turn as an AgentRun — Phase 20.
 * Owns the full dialog for one prompt: transport start, initialize,
 * session/new (or session/load on resume), optional set_model, prompt,
 * then completion off the prompt response. Mirrors DefaultRun's completion semantics:
 * clean end resolves, failures surface as error events + done while
 * result() rejects with the typed error.
 */
export class AcpRun implements AgentRun {
  public readonly id: string;
  private readonly transport: AcpTransport;
  private readonly parser: AcpParser;
  private readonly cwd: string;
  private readonly model: string | undefined;
  private readonly resumeSessionId: string | undefined;
  private readonly mcpServers: McpServer[];
  private readonly onPermissionRequest: PermissionHandler | undefined;
  private readonly images: ImageInput[] | undefined;
  private readonly timeoutMs: number;
  private readonly stream = new EventStream();
  private sessionId: string | null = null;
  private finished = false;
  private unsubscribe: (() => void) | null = null;
  private completionResolve: ((e: ProcessExit) => void) | null = null;
  private completionReject: ((e: Error) => void) | null = null;
  private readonly completion: Promise<ProcessExit>;
  private _done = false;

  public constructor(id: string, options: AcpRunOptions) {
    this.id = id;
    this.transport = options.transport;
    this.parser = options.parser ?? new AcpParser();
    this.cwd = options.cwd;
    this.model = options.model;
    this.resumeSessionId = options.resumeSessionId;
    this.mcpServers = options.mcpServers ?? [];
    this.onPermissionRequest = options.onPermissionRequest;
    this.images = options.images;
    this.onPermissionRequest = options.onPermissionRequest;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.completion = new Promise<ProcessExit>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
  }

  public get done(): boolean {
    return this._done;
  }

  /** Native ACP session id once the handshake completes (null before start). */
  public get nativeSessionId(): string | null {
    return this.sessionId;
  }

  public events(): AsyncIterable<RuntimeEvent> {
    return this.stream;
  }

  /**
   * Handshake then prompt. Rejects (never half-starts) when initialize,
   * session/new, or set_model fails, so callers observe setup errors
   * instead of a silent dead run.
   */
  public async start(prompt: string): Promise<void> {
    await this.transport.start();
    if (this.onPermissionRequest !== undefined) {
      const handler = this.onPermissionRequest;
      this.transport.setAgentRequestHandler(async (method, params) => {
        if (method === "session/request_permission") {
          const req = toPermissionRequest(method, params);
          const res = await handler(req);
          return { optionId: res.optionId };
        }
        // Any other client method without a handler → -32601
        const err = new Error(`Method not implemented: ${method} -32601`) as Error & { code?: number };
        err.code = -32601;
        throw err;
      });
    }
    await this.transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: this.onPermissionRequest !== undefined,
          writeTextFile: false,
        },
        terminal: false,
      },
      // Keep in sync with package.json (no importable version constant in src).
      clientInfo: { name: "agent-runtimes", version: "0.1.0" },
    });
    let sessionId: string | null = null;
    if (this.resumeSessionId !== undefined) {
      // Capture-style resume (verified live): restore the durable upstream
      // session in a FRESH process. All three params are mandatory.
      await this.transport.request("session/load", {
        sessionId: this.resumeSessionId,
        cwd: resolve(this.cwd),
        mcpServers: buildAcpMcpServers(this.mcpServers),
      });
      sessionId = this.resumeSessionId;
    } else {
      const created: unknown = await this.transport.request("session/new", {
        cwd: resolve(this.cwd),
        mcpServers: buildAcpMcpServers(this.mcpServers),
      });
      if (typeof created === "object" && created !== null) {
        const sid = (created as Record<string, unknown>)["sessionId"];
        if (typeof sid === "string") sessionId = sid;
      }
      if (!sessionId) {
        throw new RuntimeProtocolError("ACP session/new returned no sessionId");
      }
    }
    this.sessionId = sessionId;
    this.stream.push({ type: "session_started", sessionId });
    if (this.model !== undefined) {
      await this.transport.request("session/set_model", { sessionId, modelId: this.model });
    }
    this.unsubscribe = this.transport.onMessage((msg) => {
      if (this.finished) return;
      if (typeof msg.method === "string" && msg.method === "session/update") {
        for (const e of this.parser.parseMessage(msg)) this.stream.push(e);
      }
    });
    const promptParts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (this.images !== undefined && this.images.length > 0) {
      for (const img of this.images) {
        const { base64, mimeType } = imageToBase64(img, this.cwd);
        promptParts.push({ type: "image", data: base64, mimeType });
      }
    }
    void this.transport
      .request(
        "session/prompt",
        { sessionId, prompt: promptParts },
        { timeoutMs: this.timeoutMs },
      )
      .then(
        (res) => {
          this.finishTurnOk(res);
        },
        (err: unknown) => {
          this.finishTurnError(err);
        },
      );
  }

  public async cancel(): Promise<void> {
    if (this.finished) return;
    if (this.sessionId !== null) {
      try {
        await this.transport.request(
          "session/cancel",
          { sessionId: this.sessionId },
          { timeoutMs: CANCEL_RPC_TIMEOUT_MS },
        );
      } catch {
        // Best effort — transport.close() below finishes the job.
      }
    }
    await this.close();
  }

  public async close(): Promise<void> {
    this.transport.setAgentRequestHandler(null);
    if (!this.finished) {
      this.finished = true;
      this.unsubscribe?.();
      this.stream.close();
      this.completionResolve?.({ code: null, signal: null });
    }
    await this.transport.close();
  }

  public result(): Promise<ProcessExit> {
    return this.completion;
  }

  private finishTurnOk(res: unknown): void {
    if (this.finished) return;
    this.finished = true;
    let stopReason: string | null = null;
    let usageRaw: Record<string, unknown> | undefined;
    if (typeof res === "object" && res !== null) {
      const raw = (res as Record<string, unknown>)["stopReason"];
      if (typeof raw === "string") stopReason = raw;
      const usage = (res as Record<string, unknown>)["usage"];
      if (typeof usage === "object" && usage !== null) usageRaw = usage as Record<string, unknown>;
    }
    if (usageRaw !== undefined) {
      this.stream.push({
        type: "usage",
        inputTokens: typeof usageRaw["inputTokens"] === "number" ? usageRaw["inputTokens"] : typeof usageRaw["input_tokens"] === "number" ? usageRaw["input_tokens"] : undefined,
        outputTokens: typeof usageRaw["outputTokens"] === "number" ? usageRaw["outputTokens"] : typeof usageRaw["output_tokens"] === "number" ? usageRaw["output_tokens"] : undefined,
        costUsd: typeof usageRaw["cost"] === "number" ? usageRaw["cost"] : typeof usageRaw["costUsd"] === "number" ? usageRaw["costUsd"] : undefined,
        raw: res,
      });
    }
    if (stopReason !== null && stopReason !== "end_turn") {
      this.stream.push({
        type: "error",
        error: { code: "STOP_REASON", message: `Turn ended: ${stopReason}` },
      });
    }
    this.stream.push({ type: "done" });
    this.stream.close();
    this.unsubscribe?.();
    this.completionResolve?.({ code: 0, signal: null });
  }

  private finishTurnError(err: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const e = err instanceof Error ? err : new Error(String(err));
    this.stream.push({
      type: "error",
      error: {
        code: e instanceof RuntimeTimeoutError ? "TIMEOUT" : "TURN_FAILED",
        message: e.message,
      },
    });
    this.stream.push({ type: "done" });
    this.stream.close();
    this.unsubscribe?.();
    this.completionReject?.(e);
  }
}

function toPermissionRequest(method: string, params: unknown): PermissionRequest {
  const rec = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const rawOpts = Array.isArray(rec["options"]) ? rec["options"] : [];
  const options = rawOpts
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    .map((o) => ({
      optionId: typeof o["optionId"] === "string" ? o["optionId"] : "",
      kind: typeof o["kind"] === "string" ? o["kind"] : "unknown",
      label: typeof o["label"] === "string" ? o["label"] : undefined,
    }))
    .filter((o) => o.optionId.length > 0);
  return {
    method,
    sessionId: typeof rec["sessionId"] === "string" ? rec["sessionId"] : undefined,
    toolName: typeof rec["toolName"] === "string" ? rec["toolName"] : undefined,
    path: typeof rec["path"] === "string" ? rec["path"] : undefined,
    options: options.length > 0 ? options : [{ optionId: "allow", kind: "allow_once" }],
    raw: params ?? null,
  };
}
