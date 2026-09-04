import { RuntimeProcess, type SpawnOptions } from "../core/lifecycle.js";
import { RuntimeProtocolError, RuntimeTimeoutError } from "../core/errors.js";
import type { McpServer } from "../definition/mcp.js";

/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 message.
 * Responses and agent→client requests carry `id`; notifications don't.
 */
export interface AcpMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpRequestOptions {
  /** Per-request timeout. Defaults to 30s; prompt turns pass their own. */
  timeoutMs?: number;
}

/**
 * ACP `session/new` / `session/load` MCP descriptor — Phase 21.
 * Follows the ACP convention (array-of-`{name, value}` env, as used by
 * Hermes/Kimi-style agents); mapped from the agent-agnostic `McpServer`.
 */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** Map agent-agnostic MCP servers to the ACP `mcpServers[]` payload. */
export function buildAcpMcpServers(servers: McpServer[]): AcpMcpServer[] {
  return servers.map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args ?? [],
    env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
  }));
}

export type AcpMessageHandler = (msg: AcpMessage) => void;

export type AcpAgentRequestHandler = (method: string, params: unknown) => Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * ACP JSON-RPC transport over stdio — Phase 20.
 * Spawns `<bin> acp`, frames newline-delimited JSON-RPC, correlates
 * request/response by id, and broadcasts every parsed message to
 * subscribers. Agent→client requests (`session/request_permission`,
 * `fs/read_text_file`, etc.) are answered by the pluggable
 * `AcpAgentRequestHandler` when installed (Phase 24); otherwise a
 * `-32601 method not implemented` error is returned so the turn never
 * stalls. opencode 1.18.27 demonstrably completes full turns without
 * sending any — and an explicit error beats a stall. Serving them is
 * follow-up work once a live agent exercises the path.
 *
 * Protocol mechanics only (framing, correlation, lifecycle) — agent event
 * semantics (`session/update` → RuntimeEvent) live in `src/parser/acp.ts`
 * (Rule 3). Full cleanup on close: pending requests reject, listeners and
 * timers drop, child is SIGTERM'd then SIGKILL'd via RuntimeProcess.
 */
export class AcpTransport {
  private readonly process: RuntimeProcess;
  private readonly command: string;
  private started = false;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly subscribers = new Set<AcpMessageHandler>();
  private agentRequestHandler: AcpAgentRequestHandler | null = null;
  private readonly decoder = new TextDecoder();
  private buf = "";

  public constructor(options: SpawnOptions) {
    this.process = new RuntimeProcess(options);
    this.command = options.command;
  }

  public get pid(): number | undefined {
    return this.process.pid;
  }

  public get state(): string {
    return this.process.state;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async start(): Promise<void> {
    if (this.started) return;
    // Sync spawn failures surface as RuntimeSpawnError rejections.
    this.process.spawn();
    this.started = true;
    const stdout = this.process.stdout;
    stdout?.on("data", (chunk: Buffer) => {
      this.onBytes(chunk);
    });
    // Drain stderr so a chatty agent can never block on a full pipe.
    // Logs are discarded in v0.1 (no logger hook yet).
    this.process.stderr?.on("data", () => {});
    void this.process.wait().then(
      () => {
        this.onProcessEnd();
      },
      () => {
        this.onProcessEnd();
      },
    );
  }

  /**
   * Send a request, resolve with `result`, reject on JSON-RPC `error`,
   * timeout, or transport death. Timer is unref'd (cross-platform rule).
   */
  public request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: AcpRequestOptions,
  ): Promise<T> {
    if (!this.started || this.closed) {
      return Promise.reject(
        new RuntimeProtocolError(`ACP transport not running (method "${method}")`, {
          command: this.command,
        }),
      );
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeTimeoutError(
            `ACP request "${method}" timed out after ${String(timeoutMs)}ms`,
            {
              command: this.command,
            },
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Subscribe to every parsed protocol message. Returns an unsubscribe fn. */
  public onMessage(handler: AcpMessageHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Install/remove the `agent → client` request handler (Phase 24). */
  public setAgentRequestHandler(handler: AcpAgentRequestHandler | null): void {
    this.agentRequestHandler = handler;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(
      new RuntimeProtocolError("ACP transport closed", { command: this.command }),
    );
    this.subscribers.clear();
    await this.process.close();
    this.started = false;
  }

  private send(msg: AcpMessage): void {
    void this.process.write(`${JSON.stringify(msg)}\n`).catch(() => {
      // Write after death → close path settles pendings; nothing more to do.
    });
  }

  private onBytes(chunk: Buffer): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.trim();
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Framing garbage — never agent content. Drop (stderr already drained).
      return;
    }
    if (typeof obj !== "object" || obj === null) return;
    const msg = obj as AcpMessage;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : undefined;
    if (method !== undefined && id !== undefined) {
      void this.handleAgentRequest(method, msg.params, id);
    } else if (id !== undefined && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(id);
      if (!pending) return; // late answer to an already-timed-out request
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        pending.reject(
          new RuntimeProtocolError(`ACP error ${String(msg.error.code)}: ${msg.error.message}`, {
            command: this.command,
          }),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
    for (const sub of [...this.subscribers]) {
      try {
        sub(msg);
      } catch {
        // One bad subscriber must not break routing for the rest.
      }
    }
  }

  private async handleAgentRequest(
    method: string,
    params: unknown,
    id: number | string,
  ): Promise<void> {
    if (this.agentRequestHandler) {
      try {
        const result = await this.agentRequestHandler(method, params);
        this.send({ jsonrpc: "2.0", id, result });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If handler explicitly signals -32601, fall through to default error;
        // otherwise forward the handler's error verbatim.
        if (!message.includes("-32601")) {
          const code = err instanceof Error && (err as { code?: number }).code === -32601 ? -32601 : -32600;
          this.send({ jsonrpc: "2.0", id, error: { code, message } });
          return;
        }
      }
    }
    this.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not implemented: ${method} (no handler installed)`,
      },
    });
  }

  private onProcessEnd(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(
      new RuntimeProtocolError("ACP transport process exited", { command: this.command }),
    );
    this.subscribers.clear();
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}
