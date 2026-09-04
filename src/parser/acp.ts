import type { RuntimeEvent } from "../events/runtime-event.js";
import type { RuntimeParser } from "./parser.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * ACP session/update → RuntimeEvent mapper — Phase 20.
 * Implements RuntimeParser over newline-delimited JSON-RPC lines so fixtures
 * and transports share one code path. Only `session/update` notifications
 * yield events; responses are consumed by request correlation in
 * `src/transport/acp.ts` and ignored here.
 *
 * Verified live against opencode 1.18.27 `acp`:
 * - agent_message_chunk {content:{type:"text",text}}       → text_delta
 * - agent_thought_chunk                                    → dropped (no thinking event in v0.1)
 * - tool_call {toolCallId,title?,kind?,rawInput?}          → tool_started
 * - tool_call_update completed {…,content?,rawOutput?}     → tool_finished
 * - tool_call_update in_progress                            → dropped
 * - usage_update {used,size,inputTokens,outputTokens,       → usage (Phase 25)
 *   cacheTokens,costUsd,model}
 * - available_commands_update / future kinds                → dropped
 */
export class AcpParser implements RuntimeParser {
  private readonly decoder = new TextDecoder();
  private buf = "";

  public parse(chunk: Uint8Array): RuntimeEvent[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  public flush(): RuntimeEvent[] {
    this.buf += this.decoder.decode();
    return this.drain(true);
  }

  public reset(): void {
    this.buf = "";
  }

  private drain(isFlush: boolean): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const parts = this.buf.split("\n");
    const complete = isFlush ? parts : parts.slice(0, -1);
    this.buf = isFlush ? "" : (parts[parts.length - 1] ?? "");
    for (const raw of complete) {
      const line = raw.trim();
      if (!line) continue;
      events.push(...this.handleLine(line));
    }
    return events;
  }

  private handleLine(line: string): RuntimeEvent[] {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return [
        {
          type: "error",
          error: { code: "INVALID_JSON", message: `Invalid JSON: ${line.slice(0, 200)}` },
        },
      ];
    }
    return this.handleMessage(obj);
  }

  /** Direct entry for already-framed messages (transport path). */
  public parseMessage(msg: unknown): RuntimeEvent[] {
    if (typeof msg !== "object" || msg === null) {
      return [{ type: "error", error: { code: "INVALID_JSON", message: "Invalid ACP message" } }];
    }
    return this.handleMessage(msg);
  }

  private handleMessage(obj: unknown): RuntimeEvent[] {
    const rec = asRecord(obj);
    if (asString(rec?.["method"]) !== "session/update") return [];
    const update = asRecord(asRecord(rec?.["params"])?.["update"]);
    const kind = update ? asString(update["sessionUpdate"]) : undefined;
    switch (kind) {
      case "agent_message_chunk": {
        const content = asRecord(update?.["content"]);
        const text = asString(content?.["text"]);
        if (!text) return [];
        return [{ type: "text_delta", text }];
      }
      case "agent_thought_chunk": {
        return [];
      }
      case "tool_call": {
        return [
          {
            type: "tool_started",
            id: asString(update?.["toolCallId"]) ?? "tool_0",
            name: asString(update?.["title"]) ?? asString(update?.["kind"]) ?? "tool",
            input: update?.["rawInput"],
          },
        ];
      }
      case "tool_call_update": {
        const status = asString(update?.["status"]);
        if (status !== "completed" && status !== "failed") return [];
        return [
          {
            type: "tool_finished",
            id: asString(update?.["toolCallId"]) ?? "tool_0",
            output: update?.["rawOutput"] ?? update?.["content"],
            error: status === "failed",
          },
        ];
      }
      case "usage_update": {
        return [
          {
            type: "usage",
            inputTokens: typeof update?.["inputTokens"] === "number" ? update["inputTokens"] : undefined,
            outputTokens: typeof update?.["outputTokens"] === "number" ? update["outputTokens"] : undefined,
            cacheTokens: typeof update?.["cacheTokens"] === "number" ? update["cacheTokens"] : undefined,
            costUsd: typeof update?.["cost"] === "number" ? update["cost"] : typeof update?.["costUsd"] === "number" ? update["costUsd"] : undefined,
            model: asString(update?.["model"]),
            raw: update,
          },
        ];
      }
      default: {
        return [];
      }
    }
  }
}
