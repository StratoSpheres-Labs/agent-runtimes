import { JsonlParser } from "../../src/parser/jsonl.js";
import type { RuntimeEvent } from "../../src/events/runtime-event.js";
import type { RuntimeParser } from "../../src/parser/parser.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Claude Code parser — Phase 12
 * Converts `claude --output-format stream-json` JSONL into RuntimeEvent.
 * Handles claude's shapes (per open-design's claude-stream.ts):
 *  {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}} → text_delta
 *  {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"...","input":{}}]}} → tool_started
 *  {"type":"tool_result","tool_use_id":"...","content":"..."} → tool_finished
 *  {"type":"user","message":{"content":[{"type":"tool_result",...}]}} → tool_finished
 *    (print mode delivers tool results inside a `user` transcript envelope —
 *    verified live on 2.1.187; other user-envelope blocks are ignored, not errored)
 *  {"type":"result","subtype":"success"|"error"} → done
 *  {"type":"system",...} (init / hook_* envelopes) → ignored (transport
 *    metadata, not events; surfacing them as errors spams every run).
 *
 * Buffering lives HERE (persistent decoder + line buffer, mirroring
 * JsonlParser): only complete lines are ever interpreted, so shapes split
 * across chunks can neither be misread nor lost. Anything unrecognized is
 * delegated to the generic JsonlParser, preserving INVALID_JSON /
 * UNKNOWN_EVENT visibility. Parser owns no process/session state (Rule 4).
 */
export class ClaudeParser implements RuntimeParser {
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
      case "assistant": {
        const msg = rec["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"];
        const events: RuntimeEvent[] = [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null) continue;
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") {
              events.push({ type: "text_delta", text: b["text"] });
            } else if (b["type"] === "tool_use") {
              const name = asString(b["name"]) ?? "tool";
              const id = asString(b["id"]) ?? "tool_0";
              if (name === "AskUserQuestion") {
                const input = b["input"] as Record<string, unknown> | undefined;
                const questions = input !== undefined && Array.isArray(input["questions"]) ? input["questions"] : [];
                const first = questions[0] as Record<string, unknown> | undefined;
                const prompt = first !== undefined && typeof first["question"] === "string" ? first["question"] : undefined;
                const rawOpts = first !== undefined && Array.isArray(first["options"]) ? first["options"] : [];
                const options = rawOpts
                  .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
                  .map((o) => ({
                    optionId: typeof o["label"] === "string" ? o["label"] : "allow",
                    kind: typeof o["kind"] === "string" ? o["kind"] : "allow_once",
                    label: typeof o["label"] === "string" ? o["label"] : undefined,
                  }));
                events.push({
                  type: "permission_request",
                  id,
                  toolName: name,
                  prompt,
                  options: options.length > 0 ? options : [{ optionId: "allow", kind: "allow_once" }],
                  raw: b["input"],
                });
              } else {
                events.push({
                  type: "tool_started",
                  id,
                  name,
                  input: b["input"],
                });
              }
            }
            // Other block types (e.g. thinking) have no v0.1 event — dropped,
            // not errored: the envelope itself was valid.
          }
        }
        return events;
      }
      case "tool_result": {
        return [
          {
            type: "tool_finished",
            id: asString(rec["tool_use_id"]) ?? asString(rec["id"]) ?? "tool_0",
            output: rec["content"],
          },
        ];
      }
      case "user": {
        // Transcript echo of tool results (print-mode shape, verified live).
        const msg = rec["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"];
        const events: RuntimeEvent[] = [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null) continue;
            const b = block as Record<string, unknown>;
            if (b["type"] === "tool_result") {
              events.push({
                type: "tool_finished",
                id: asString(b["tool_use_id"]) ?? "tool_0",
                output: b["content"],
                ...(b["is_error"] === true ? { error: true as const } : {}),
              });
            }
            // Other user-envelope blocks (text echoes, images) are transcript
            // machinery — recognized, not errored.
          }
        }
        return events;
      }
      case "result": {
        const subtype = asString(rec["subtype"]);
        if (subtype === "success" || subtype === "error") {
          const events: RuntimeEvent[] = [];
          const usage = rec["usage"] as Record<string, unknown> | undefined;
          const cost =
            typeof rec["total_cost_usd"] === "number"
              ? rec["total_cost_usd"]
              : typeof rec["cost"] === "number"
                ? rec["cost"]
                : undefined;
          if (usage !== undefined || cost !== undefined) {
            events.push({
              type: "usage",
              inputTokens: typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : undefined,
              outputTokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
              cacheTokens: typeof usage?.["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : typeof usage?.["cache_creation_input_tokens"] === "number" ? usage["cache_creation_input_tokens"] : undefined,
              costUsd: cost,
              model: asString(rec["model"]),
              raw: rec,
            });
          }
          events.push({ type: "done" });
          return events;
        }
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
      case "system": {
        // Transport metadata (hook_started, hook_response, …) — ignore,
        // except `init`, which carries the native session id for resume.
        if (asString(rec["subtype"]) === "init") {
          const sid = asString(rec["session_id"]);
          if (sid) return [{ type: "session_started", sessionId: sid }];
        }
        return [];
      }
      default: {
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
    }
  }
}
