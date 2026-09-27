import { describe, expect, it } from "vitest";
import { EventStream, MAX_STREAM_QUEUE_LENGTH } from "../src/events/event-stream.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import { JsonlParser, MAX_PARSER_BUFFER_BYTES, bufferOverflowError } from "../src/parser/jsonl.js";
import { AcpParser } from "../src/parser/acp.js";
import { ClaudeParser } from "../runtimes/claude/parser.js";
import { OpencodeParser } from "../runtimes/opencode/parser.js";
import { CodexParser } from "../runtimes/codex/parser.js";
import { AcpTransport } from "../src/transport/acp.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function textEvent(i: number): RuntimeEvent {
  return { type: "text_delta", text: `t${String(i)}` };
}

describe("EventStream bound", () => {
  it("drops data past the cap with a single BUFFER_OVERFLOW error", () => {
    const stream = new EventStream();
    const total = MAX_STREAM_QUEUE_LENGTH + 5;
    for (let i = 0; i < total; i++) stream.push(textEvent(i));
    const seen: RuntimeEvent[] = [];
    const done = (async () => {
      for await (const e of stream) seen.push(e);
    })();
    stream.close();
    return done.then(() => {
      const errors = seen.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      if (errors[0]?.type === "error") {
        expect(errors[0].error.code).toBe("BUFFER_OVERFLOW");
      }
      // Bounded: cap data events + the single overflow signal.
      expect(seen.length).toBeLessThanOrEqual(MAX_STREAM_QUEUE_LENGTH + 1);
      // The first events are intact (drop-newest, never drop-oldest).
      expect(seen[0]).toEqual(textEvent(0));
    });
  });

  it("done always flows, even past the cap", () => {
    const stream = new EventStream();
    for (let i = 0; i < MAX_STREAM_QUEUE_LENGTH + 3; i++) stream.push(textEvent(i));
    stream.push({ type: "done", exitCode: 0, signal: null });
    const seen: RuntimeEvent[] = [];
    const done = (async () => {
      for await (const e of stream) {
        seen.push(e);
        if (e.type === "done") break;
      }
    })();
    stream.close();
    return done.then(() => {
      expect(seen[seen.length - 1]?.type).toBe("done");
    });
  });

  it("live consumers never trip the cap", async () => {
    const stream = new EventStream();
    const seen: RuntimeEvent[] = [];
    const draining = (async () => {
      for await (const e of stream) {
        seen.push(e);
        if (e.type === "done") break;
      }
    })();
    for (let i = 0; i < 500; i++) stream.push(textEvent(i));
    stream.push({ type: "done" });
    stream.close();
    await draining;
    expect(seen.filter((e) => e.type === "error")).toHaveLength(0);
    expect(seen.filter((e) => e.type === "text_delta")).toHaveLength(500);
  });
});

describe("parser buffer bound", () => {
  it("bufferOverflowError carries code and cap", () => {
    const e = bufferOverflowError("X", 123);
    expect(e).toEqual({
      type: "error",
      error: {
        code: "BUFFER_OVERFLOW",
        message: "X buffer exceeded 123 bytes — dropping partial line",
      },
    });
  });

  it("JsonlParser drops a newline-less flood and stays usable", () => {
    const p = new JsonlParser();
    const flood = "z".repeat(MAX_PARSER_BUFFER_BYTES + 100);
    // Feed in chunks so no single append dwarfs the check.
    const chunk = 65_536;
    let overflow = 0;
    for (let i = 0; i < flood.length; i += chunk) {
      const evs = p.parse(enc(flood.slice(i, i + chunk)));
      overflow += evs.filter(
        (e) => e.type === "error" && e.error.code === "BUFFER_OVERFLOW",
      ).length;
    }
    expect(overflow).toBeGreaterThanOrEqual(1);
    // Buffer was reset: flush the short remainder, then a normal line
    // parses immediately after (parser stays usable post-overflow).
    p.flush();
    const after = p.parse(enc('{"type":"text_delta","text":"hi"}\n'));
    expect(after).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  it.each([
    ["ClaudeParser", () => new ClaudeParser()],
    ["OpencodeParser", () => new OpencodeParser()],
    ["CodexParser", () => new CodexParser()],
    ["AcpParser", () => new AcpParser()],
  ])("%s drops a newline-less flood with BUFFER_OVERFLOW", (_name, make) => {
    const p = make();
    const flood = "q".repeat(MAX_PARSER_BUFFER_BYTES + 16);
    const evs = p.parse(enc(flood));
    expect(evs.some((e) => e.type === "error" && e.error.code === "BUFFER_OVERFLOW")).toBe(true);
  });
});

describe("AcpTransport buffer bound", () => {
  it("a newline-less flood fails pending requests with BUFFER_OVERFLOW and dies", async () => {
    const t = new AcpTransport({
      // Prints one 5MB newline-less line, then idles (never speaks JSON-RPC).
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${String(MAX_PARSER_BUFFER_BYTES + 1024)}))`],
    });
    await t.start();
    // A request that can never resolve: the flood kills it via fail-fast.
    const pending = t.request("session/prompt", {}, { timeoutMs: 15_000 });
    await expect(pending).rejects.toThrow(/BUFFER_OVERFLOW|buffer overflow/i);
    await t.close().catch(() => {});
  }, 20000);
});
