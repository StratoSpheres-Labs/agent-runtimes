import { JsonlParser } from "../../src/parser/jsonl.js";
import type { RuntimeEvent } from "../../src/events/runtime-event.js";
import { asJsonValue } from "../../src/events/runtime-event.js";
import type { RuntimeParser } from "../../src/parser/parser.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * OpenCode parser — Task 9.3 + Phase 10
 * Converts `opencode run --format json` JSONL into RuntimeEvent.
 * Handles 1.18.27 real shapes (top-level `type` + nested `part`):
 *   {"type":"text","part":{"type":"text","text":"..."}}          → text_delta
 *   {"type":"reasoning","part":{"type":"reasoning","text":"..."}} → reasoning_delta
 *     (only with `--thinking`; empty text → dropped)
 *   {"type":"step_start","sessionID":"..."}                       → session_started
 *   {"type":"step_finish",...}                                   → (ignored — a run emits
 *                                                                  step_finish per step, so only
 *                                                                  process exit ends the run and
 *                                                                  DefaultRun synthesizes `done`)
 *   {"type":"tool_use","part":{"type":"tool","tool":"read",
 *     "callID":"call_...","state":{"input":{...}}}}               → tool_started
 *   {"type":"tool_use","part":{"type":"tool","tool":"bash",
 *     "callID":"call_...","state":{"status":"completed",
 *     "input":{...},"output":"..."}}}                             → tool_started + tool_finished
 *   Fast tools arrive as ONE completed line (start+finish together);
 *   slow tools as pending/running then completed. A seen-set pairs them so
 *   a finish always has exactly one preceding start with the same id.
 *   plus generic JsonlParser shapes (tool/tool_result/error/done, …).
 *
 * Buffering lives HERE (persistent decoder + line buffer, mirroring
 * JsonlParser): only complete lines are ever interpreted, so shapes split
 * across chunks can neither be misread nor lost. Anything unrecognized is
 * delegated to the generic JsonlParser, preserving INVALID_JSON /
 * UNKNOWN_EVENT visibility. Parser owns no process/session state (Rule 4).
 */
export class OpencodeParser implements RuntimeParser {
  private readonly inner = new JsonlParser();
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buf = "";
  /** callIDs already emitted as tool_started (pairs start/finish per id). */
  private readonly seenToolIds = new Set<string>();

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
    this.seenToolIds.clear();
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
    const part = rec["part"] as Record<string, unknown> | undefined;
    const type = asString(rec["type"]);
    switch (type) {
      case "text": {
        const text = asString(part?.["text"]) ?? asString(rec["text"]) ?? "";
        return [{ type: "text_delta", text }];
      }
      case "reasoning": {
        // Thinking summary, emitted only with `--thinking` (which the
        // adapter now passes by default). Empty text (e.g. encrypted-only
        // reasoning, verified live) is a valid envelope — drop, don't error.
        const text = asString(part?.["text"]) ?? asString(rec["text"]) ?? "";
        return text ? [{ type: "reasoning_delta", text }] : [];
      }
      case "step_start": {
        const sessionId = asString(rec["sessionID"]) ?? asString(part?.["sessionID"]);
        if (sessionId) return [{ type: "session_started", sessionId }];
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
      case "step_finish": {
        // Per-step marker, NOT run-terminal (see class docstring).
        return [];
      }
      case "tool_use": {
        const state = part?.["state"] as Record<string, unknown> | undefined;
        const rawId = asString(part?.["callID"]) ?? asString(part?.["id"]) ?? asString(rec["id"]);
        const id = rawId ?? "tool_0";
        const name =
          asString(part?.["tool"]) ?? asString(part?.["name"]) ?? asString(rec["name"]) ?? "tool";
        const input = asJsonValue(state?.["input"] ?? part?.["input"] ?? rec["input"]);
        const status = asString(state?.["status"])?.toLowerCase();
        const started: RuntimeEvent = { type: "tool_started", id, name, input };
        if (status !== "completed" && status !== "error") {
          // Pending/running (or unknown): start only, deduped per callID so
          // a later completed line doesn't double-emit the start.
          // Untracked fallback ids ("tool_0") always emit (old behavior) —
          // deduping them would swallow distinct tools sharing no id.
          if (rawId !== undefined && this.seenToolIds.has(rawId)) return [];
          if (rawId !== undefined) this.seenToolIds.add(rawId);
          return [started];
        }
        // Completed/error: finish, preceded by exactly one start with the
        // same id (emit the start here when only the completed line arrived).
        const meta = state?.["metadata"] as Record<string, unknown> | undefined;
        const exitCode = typeof meta?.["exit"] === "number" ? meta["exit"] : undefined;
        const events: RuntimeEvent[] = [];
        if (rawId === undefined || !this.seenToolIds.has(rawId)) {
          events.push(started);
        }
        if (rawId !== undefined) this.seenToolIds.add(rawId);
        events.push({
          type: "tool_finished",
          id,
          output: asJsonValue(state?.["output"] ?? meta?.["output"]),
          error: status === "error" || (exitCode !== undefined && exitCode !== 0),
        });
        return events;
      }
      case "tool": {
        // Legacy alias — same mapping the old normalizeChunk produced via inner.
        return [
          {
            type: "tool_started",
            id: asString(rec["id"]) ?? "tool_0",
            name: asString(rec["name"]) ?? "tool",
            input: asJsonValue(rec["input"]),
          },
        ];
      }
      case "tool_result": {
        return [
          {
            type: "tool_finished",
            id: asString(rec["id"]) ?? "tool_0",
            output: asJsonValue(rec["output"]),
            error: Boolean(rec["error"]),
          },
        ];
      }
      case "error": {
        // Surface nested provider errors readably, e.g. opencode APIError:
        // {"error":{"name":"APIError","data":{"message":"credit insufficient…"}}}
        const err = rec["error"] as Record<string, unknown> | undefined;
        const data = err?.["data"] as Record<string, unknown> | undefined;
        const code = asString(err?.["name"]) ?? "UNKNOWN";
        const message =
          asString(data?.["message"]) ?? asString(err?.["message"]) ?? "unknown error";
        // NOTE: trailing "\n" is required — inner buffers newline-less input.
        return this.inner.parse(
          this.encoder.encode(JSON.stringify({ type: "error", error: { code, message } }) + "\n"),
        );
      }
      default: {
        return this.inner.parse(this.encoder.encode(line + "\n"));
      }
    }
  }
}
