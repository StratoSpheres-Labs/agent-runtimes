import type { RuntimeEvent } from "../events/runtime-event.js";
import type { RuntimeParser } from "./parser.js";

/**
 * JsonlParser — handles:
 * - partial chunk buffering (Task 8.2)
 * - multiple events coalesced in one chunk
 * - illegal JSON / unknown event / empty input (Task 8.3)
 * No process/session control (Rule 4).
 */
export class JsonlParser implements RuntimeParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  public parse(chunk: Uint8Array): RuntimeEvent[] {
    const text = this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    return this.drain(false);
  }

  public flush(): RuntimeEvent[] {
    // Flush decoder remainder
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    return this.drain(true);
  }

  public reset(): void {
    this.buffer = "";
  }

  private drain(isFlush: boolean): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    // Split on newline; keep last partial in buffer unless flushing
    const lines = this.buffer.split("\n");
    const complete = isFlush ? lines : lines.slice(0, -1);
    this.buffer = isFlush ? "" : (lines[lines.length - 1] ?? "");

    for (const raw of complete) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const ev = this.parseLine(line);
      if (ev) events.push(ev);
      else {
        // Illegal JSON → error event, not thrown (keeps stream alive)
        events.push({
          type: "error",
          error: { code: "INVALID_JSON", message: `Invalid JSON: ${line.slice(0, 200)}` },
        });
      }
    }
    // On flush, if leftover non-empty and not drained, try once more
    if (isFlush && this.buffer.trim().length > 0) {
      const line = this.buffer.trim();
      const ev = this.parseLine(line);
      if (ev) events.push(ev);
      else {
        events.push({
          type: "error",
          error: { code: "INVALID_JSON", message: `Invalid JSON: ${line.slice(0, 200)}` },
        });
      }
      this.buffer = "";
    }
    return events;
  }

  private parseLine(line: string): RuntimeEvent | null {
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      return null;
    }
    if (typeof obj !== "object" || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    const type = rec["type"];
    if (typeof type !== "string") return null;

    // Map known types; unknown → null (caller emits error)
    switch (type) {
      case "text_delta":
      case "text": {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const text = typeof rec["text"] === "string" ? (rec["text"] as string) : "";
        return { type: "text_delta", text };
      }
      case "tool_started": {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const id = typeof rec["id"] === "string" ? (rec["id"] as string) : "tool_0";
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const name = typeof rec["name"] === "string" ? (rec["name"] as string) : "tool";
        return { type: "tool_started", id, name, input: rec["input"] };
      }
      case "tool_finished": {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const id = typeof rec["id"] === "string" ? (rec["id"] as string) : "tool_0";
        return { type: "tool_finished", id, output: rec["output"], error: Boolean(rec["error"]) };
      }
      case "error": {
        const err = rec["error"] as { code?: string; message?: string } | undefined;
        const fallbackMessage =
          typeof rec["message"] === "string" ? rec["message"] : "unknown error";
        return {
          type: "error",
          error: {
            code: typeof err?.code === "string" ? err.code : "UNKNOWN",
            message: typeof err?.message === "string" ? err.message : fallbackMessage,
          },
        };
      }
      case "done":
      case "session_finished": {
        return { type: "done" };
      }
      case "session_started": {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const sid = typeof rec["sessionId"] === "string" ? (rec["sessionId"] as string) : "";
        return { type: "session_started", sessionId: sid };
      }
      case "usage": {
        return {
          type: "usage",
          inputTokens: typeof rec["inputTokens"] === "number" ? rec["inputTokens"] : undefined,
          outputTokens: typeof rec["outputTokens"] === "number" ? rec["outputTokens"] : undefined,
          cacheTokens: typeof rec["cacheTokens"] === "number" ? rec["cacheTokens"] : undefined,
          costUsd: typeof rec["costUsd"] === "number" ? rec["costUsd"] : undefined,
          model: typeof rec["model"] === "string" ? rec["model"] : undefined,
          raw: rec["raw"],
        };
      }
      default: {
        // Unknown event type → surface as error event for visibility
        return {
          type: "error",
          error: { code: "UNKNOWN_EVENT", message: `Unknown event type: ${type}` },
        };
      }
    }
  }
}
