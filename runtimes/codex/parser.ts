import {
  JsonlParser,
  MAX_PARSER_BUFFER_BYTES,
  bufferOverflowError,
} from "../../src/parser/jsonl.js";
import type { RuntimeEvent } from "../../src/events/runtime-event.js";
import { asJsonValue } from "../../src/events/runtime-event.js";
import type { RuntimeParser } from "../../src/parser/parser.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Codex parser — Phase 13, shapes verified live against codex-cli 0.150.1
 * and re-verified on 0.156.1 (`codex exec --json`):
 *  {"type":"thread.started","thread_id":"..."}                  → session_started
 *  {"type":"turn.started"}                                     → ignored (transport marker)
 *  {"type":"item.started","item":{"type":"command_execution",
 *    "id":"..."}}                                               → tool_started
 *  {"type":"item.started","item":{"type":"reasoning",...}}      → ignored
 *  {"type":"item.completed","item":{"type":"reasoning",
 *    "text":"..."}}                                              → reasoning_delta
 *                                                                 (empty → dropped)
 *  {"type":"item.completed","item":{"type":"command_execution",
 *    "id":"...",...}}                                           → tool_finished
 *                                                                  (error:true on
 *                                                                   nonzero exit_code)
 *  {"type":"item.completed","item":{"type":"error",...}}          → dropped
 *    (stream-level warnings, e.g. ignored config keys — no tool call
 *    behind them; same lines stay on stderr)
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
    const retained = isFlush ? "" : (parts[parts.length - 1] ?? "");
    if (retained.length > MAX_PARSER_BUFFER_BYTES) {
      // Newline-less flood: drop the partial (never a valid line at this
      // size) and say so — memory stays bounded, stream alive.
      this.buf = "";
      events.push(bufferOverflowError("CodexParser", MAX_PARSER_BUFFER_BYTES));
    } else {
      this.buf = retained;
    }
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
      case "error": {
        // Recoverable progress notices — verified live on 0.159.x:
        // `{"type":"error","message":"Reconnecting... 3/5 (…)"}` while the
        // transport retries. They fell through to `default:` and came back as
        // an `UNKNOWN` error event, so a turn that was *recovering* was marked
        // failed on every retry — five spurious failures on a 4-minute stall.
        //
        // Dropped with provenance, exactly like the config-warning
        // `item.completed/error` below. The definitive failure still arrives as
        // `turn.failed`, which carries the real reason.
        return [];
      }
      case "turn.failed": {
        // The ONLY place codex states why a turn failed, and the terminal
        // counterpart to `turn.completed`. Without this case the reason falls
        // through to `default:` and is lost, so the run ends as
        // NON_ZERO_EXIT / "Process exited with code 1" — verified live on a
        // network-blocked box, where codex said
        // `turn.failed: workspace routing discovery timed out` and exited 1.
        // The user got the exit code and none of the cause.
        //
        // The trailing `done` is what makes the cause survive: `Run` skips its
        // own NON_ZERO_EXIT once a parser has emitted a terminal `done`
        // (`sawDone`), so this error is the one the caller ends up holding.
        const err = rec["error"] as Record<string, unknown> | undefined;
        const message =
          asString(err?.["message"]) ??
          asString(rec["message"]) ??
          "codex turn failed (no reason given)";
        const code = asString(err?.["code"]) ?? "TURN_FAILED";
        return [{ type: "error", error: { code, message } }, { type: "done" }];
      }
      case "turn.completed": {
        const usage = rec["usage"] as Record<string, unknown> | undefined;
        if (usage !== undefined) {
          return [
            {
              type: "usage",
              inputTokens:
                typeof usage["input_tokens"] === "number"
                  ? usage["input_tokens"]
                  : typeof usage["inputTokens"] === "number"
                    ? usage["inputTokens"]
                    : undefined,
              outputTokens:
                typeof usage["output_tokens"] === "number"
                  ? usage["output_tokens"]
                  : typeof usage["outputTokens"] === "number"
                    ? usage["outputTokens"]
                    : typeof usage["output_tokens"] === "number"
                      ? usage["output_tokens"]
                      : undefined,
              costUsd:
                typeof usage["cost"] === "number"
                  ? usage["cost"]
                  : typeof rec["cost"] === "number"
                    ? rec["cost"]
                    : undefined,
              raw: asJsonValue(rec),
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
        // Reasoning only ever arrives as item.completed (codex source:
        // AgentReasoning → ItemCompleted with the full text) — a started
        // reasoning item would only produce a fake tool_start, so skip it.
        if (item?.["type"] === "reasoning") return [];
        return [
          {
            type: "tool_started",
            id: asString(item?.["id"]) ?? "tool_0",
            name: asString(item?.["type"]) ?? "tool",
            input: asJsonValue(item),
          },
        ];
      }
      case "item.completed": {
        const item = rec["item"] as Record<string, unknown> | undefined;
        const id = asString(item?.["id"]) ?? "tool_0";
        // Stream-level warnings (e.g. "ignoring unrecognized configuration
        // setting") arrive as item.completed/error with no tool call behind
        // them — verified live on 0.156.1. Emitting tool_finished would fake
        // a tool pairing, and an `error` event would false-alarm a healthy
        // turn, so drop with provenance (the same lines stay on stderr).
        if (item?.["type"] === "error") return [];
        // Reasoning summaries are display-only thinking — never tool
        // events (previously they surfaced as tool_started/tool_finished
        // with name "reasoning"). Empty text → dropped, not errored.
        if (item?.["type"] === "reasoning") {
          const text = asString(item["text"]) ?? "";
          return text ? [{ type: "reasoning_delta", text }] : [];
        }
        const events: RuntimeEvent[] = [];
        // Agent messages carry the model text — surface it as text_delta
        // (it appears nowhere else in the stream).
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
          events.push({ type: "text_delta", text: item["text"] });
        }
        // A nonzero command exit is the only failure signal exec gives —
        // surface it so failed commands read differently from clean ones.
        const exitCode = typeof item?.["exit_code"] === "number" ? item["exit_code"] : undefined;
        events.push({
          type: "tool_finished",
          id,
          output: asJsonValue(item),
          error: exitCode !== undefined && exitCode !== 0,
        });
        return events;
      }
      default: {
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
    }
  }
}
