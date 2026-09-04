import { JsonlParser } from "../../src/parser/jsonl.js";
import type { RuntimeEvent } from "../../src/events/runtime-event.js";
import type { RuntimeParser } from "../../src/parser/parser.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Codex parser — Phase 13, shapes verified live against codex-cli 0.150.1
 * (`codex exec --json`):
 *  {"type":"thread.started","thread_id":"..."}                  → session_started
 *  {"type":"turn.started"}                                     → ignored (transport marker)
 *  {"type":"item.started","item":{"type":"command_execution",
 *    "id":"..."}}                                               → tool_started
 *  {"type":"item.completed","item":{"type":"command_execution",
 *    "id":"...",...}}                                           → tool_finished
 *  {"type":"item.completed","item":{"type":"agent_message",
 *    "id":"...","text":"..."}}                                  → text_delta + tool_finished
 *                                                                 (the model text lives here)
 *  {"type":"turn.completed",...}                               → done (no status
 *                                                                 field in 0.150.1)
 *  {"type":"text","text":"..."} / {"type":"message",...}       → text_delta
 *                                                                 (legacy compat)
 *
 * Buffering lives HERE (persistent decoder + line buffer, mirroring
 * JsonlParser): only complete lines are ever interpreted, so shapes split
 * across chunks can neither be misread nor lost, and each line yields its
 * events exactly once (the old normalize+merge design double-emitted
 * tool_finished). Anything unrecognized is delegated to the generic
 * JsonlParser, preserving INVALID_JSON / UNKNOWN_EVENT visibility.
 * Parser owns no process/session state (Rule 4).
 */
export class CodexParser implements RuntimeParser {
  private readonly inner = new JsonlParser();
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buf = "";

  public parse(chunk: Uint8Array): RuntimeEvent[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  public flush(): RuntimeEvent[] {
    this.buf += this.decoder.decode();
    const events = this.drain(true);
    events.push(...this.inner.flush());
    return events;
  }

  public reset(): void {
    this.buf = "";
    this.inner.reset();
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
      obj = JSON.parse(line) as unknown;
    } catch {
      return this.inner.parse(this.encoder.encode(line + "\n"));
    }
    if (typeof obj !== "object" || obj === null) {
      return this.inner.parse(this.encoder.encode(line + "\n"));
    }
    const rec = obj as Record<string, unknown>;
    const type = asString(rec["type"]);
    switch (type) {
      case "thread.started": {
        const tid = asString(rec["thread_id"]) ?? "codex-thread";
        return [{ type: "session_started", sessionId: tid }];
      }
      case "turn.started": {
        // Transport marker, not an event.
        return [];
      }
      case "turn.completed": {
        const usage = rec["usage"] as Record<string, unknown> | undefined;
        if (usage !== undefined) {
          return [
            {
              type: "usage",
              inputTokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : typeof usage["inputTokens"] === "number" ? usage["inputTokens"] : undefined,
              outputTokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
              costUsd: typeof usage["cost"] === "number" ? usage["cost"] : typeof rec["cost"] === "number" ? rec["cost"] : undefined,
              raw: rec,
            },
            { type: "done" },
          ];
        }
        return [{ type: "done" }];
      }
      case "text": {
        return [{ type: "text_delta", text: asString(rec["text"]) ?? "" }];
      }
      case "message": {
        const content = asString(rec["content"]);
        if (content === undefined) {
          return this.inner.parse(this.encoder.encode(line + "\n"));
        }
        return [{ type: "text_delta", text: content }];
      }
      case "item.started": {
        const item = rec["item"] as Record<string, unknown> | undefined;
        return [
          {
            type: "tool_started",
            id: asString(item?.["id"]) ?? "tool_0",
            name: asString(item?.["type"]) ?? "tool",
            input: item,
          },
        ];
      }
      case "item.completed": {
        const item = rec["item"] as Record<string, unknown> | undefined;
        const id = asString(item?.["id"]) ?? "tool_0";
        const events: RuntimeEvent[] = [];
        // Agent messages carry the model text — surface it as text_delta
        // (it appears nowhere else in the stream).
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
          events.push({ type: "text_delta", text: item["text"] });
        }
        events.push({ type: "tool_finished", id, output: item });
        return events;
      }
      default: {
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
    }
  }
}
