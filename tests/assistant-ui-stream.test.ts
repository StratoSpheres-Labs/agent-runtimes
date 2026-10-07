import { describe, expect, it } from "vitest";
import { RuntimeProtocolError } from "../src/core/errors.js";
import type { RuntimeEvent } from "../src/events/runtime-event.js";
import {
  decodeNdjsonChunk,
  decodeSseChunk,
  readNdjsonEvents,
  readSseEvents,
  type ByteStreamLike,
} from "../src/frontend/assistant-ui/stream.js";
import { encodeRuntimeEvent } from "../src/wire.js";

const encoder = new TextEncoder();

/** Drive a chunk decoder like the real reader does, feeding chunks in order. */
function drain(
  decode: (buffered: string, chunk: string) => { events: RuntimeEvent[]; rest: string },
  chunks: readonly string[],
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let rest = "";
  for (const chunk of chunks) {
    const step = decode(rest, chunk);
    rest = step.rest;
    events.push(...step.events);
  }
  const tail = decode(rest, "");
  events.push(...tail.events);
  return events;
}

/** A `ReadableStream` stand-in that emits the given chunks then closes. */
function streamOf(chunks: readonly string[]): ByteStreamLike {
  let index = 0;
  return {
    getReader: () => ({
      read: () => {
        if (index >= chunks.length) return Promise.resolve({ done: true });
        const value = encoder.encode(chunks[index]);
        index += 1;
        return Promise.resolve({ done: false, value });
      },
      releaseLock: () => {},
    }),
  };
}

/** Same, but emitting RAW bytes so a UTF-8 sequence can be split mid-character. */
function byteStreamOf(chunks: readonly Uint8Array[]): ByteStreamLike {
  let index = 0;
  return {
    getReader: () => ({
      read: () => {
        if (index >= chunks.length) return Promise.resolve({ done: true });
        const value = chunks[index];
        index += 1;
        return Promise.resolve({ done: false, value });
      },
      releaseLock: () => {},
    }),
  };
}

const TEXT: RuntimeEvent[] = [
  { type: "session_started", sessionId: "s1", runId: "sess_a:run1" },
  { type: "text_delta", text: "hi", runId: "sess_a:run1" },
  { type: "done", runId: "sess_a:run1" },
];

function sse(events: readonly RuntimeEvent[]): string {
  return events.map((e) => `data: ${encodeRuntimeEvent(e)}`).join("");
}

function ndjson(events: readonly RuntimeEvent[]): string {
  return events.map((e) => encodeRuntimeEvent(e)).join("");
}

describe("NDJSON decoding", () => {
  it("decodes one event per line and buffers the partial tail", () => {
    const { events, rest } = decodeNdjsonChunk(
      "",
      `${encodeRuntimeEvent(TEXT[0] as RuntimeEvent)}{"type":"text_delta","tex`,
    );
    expect(events).toEqual([TEXT[0]]);
    expect(rest).toBe('{"type":"text_delta","tex');
  });

  it("decodes coalesced lines in one chunk", () => {
    const events = drain(decodeNdjsonChunk, [ndjson(TEXT)]);
    expect(events).toEqual(TEXT);
  });

  it("decodes a JSON payload split across chunks at every boundary", () => {
    const payload = ndjson(TEXT);
    // Split mid-JSON on purpose: a partial object must never be parsed.
    for (let cut = 1; cut < payload.length; cut += 1) {
      const events = drain(decodeNdjsonChunk, [payload.slice(0, cut), payload.slice(cut)]);
      expect(events).toEqual(TEXT);
    }
  });

  it("tolerates CRLF line endings", () => {
    const events = drain(decodeNdjsonChunk, [ndjson(TEXT).replaceAll("\n", "\r\n")]);
    expect(events).toEqual(TEXT);
  });

  it("reports a malformed line as an error WITHOUT discarding the good lines", () => {
    const good = encodeRuntimeEvent(TEXT[0] as RuntimeEvent);
    const result = decodeNdjsonChunk(
      "",
      `${good}not json\n${encodeRuntimeEvent(TEXT[1] as RuntimeEvent)}`,
    );
    // The bug this pins: the decoder used to throw mid-loop and drop every
    // event decoded before the poison line — and one read can carry a whole
    // turn, so a single bad line cost the user real text.
    expect(result.events).toEqual([TEXT[0], TEXT[1]]);
    expect(result.error).toBeInstanceOf(RuntimeProtocolError);
  });

  it("reports an unknown discriminant as an error instead of throwing", () => {
    // Failing open is the documented promise for a growing event set; the
    // error travels alongside so the host can still see it.
    const result = decodeNdjsonChunk("", '{"type":"teleport"}\n');
    expect(result.events).toEqual([]);
    expect(result.error).toBeInstanceOf(RuntimeProtocolError);
  });
});

describe("SSE decoding", () => {
  it("handles spec frame terminators (data + blank line) identically", () => {
    const body = TEXT.map((e) => `data: ${encodeRuntimeEvent(e)}\n\n`).join("");
    expect(drain(decodeSseChunk, [body])).toEqual(TEXT);
  });

  it("treats each `data:` line as one event, matching examples/bff-sse.ts", () => {
    // The shipped demo writes `data: <line>\n` with NO blank-line frame
    // separator — strict SSE coalescing would swallow the whole turn into one
    // multi-line data field, so the reader must not do that.
    expect(drain(decodeSseChunk, [sse(TEXT)])).toEqual(TEXT);
  });

  it("survives a JSON payload split across chunk boundaries", () => {
    const payload = sse(TEXT);
    for (let cut = 1; cut < payload.length; cut += 1) {
      expect(drain(decodeSseChunk, [payload.slice(0, cut), payload.slice(cut)])).toEqual(TEXT);
    }
  });

  it("ignores comment heartbeats (`: keep-alive`) — proxies send these", () => {
    const body = `: keep-alive\n\ndata: ${encodeRuntimeEvent(TEXT[0] as RuntimeEvent)}\n\n`;
    expect(drain(decodeSseChunk, [body])).toEqual([TEXT[0]]);
  });

  it("ignores non-data fields (event:, id:, retry:)", () => {
    const body = `event: message\nid: 7\nretry: 3000\ndata: ${encodeRuntimeEvent(TEXT[0] as RuntimeEvent)}\n\n`;
    expect(drain(decodeSseChunk, [body])).toEqual([TEXT[0]]);
  });

  it("stops at the [DONE] sentinel without emitting it", () => {
    const body = `${sse(TEXT)}\ndata: [DONE]\n\n`;
    expect(drain(decodeSseChunk, [body])).toEqual(TEXT);
  });

  it("tolerates CRLF framing from proxies", () => {
    const body = sse(TEXT).replaceAll("\n", "\r\n");
    expect(drain(decodeSseChunk, [body])).toEqual(TEXT);
  });

  it("reports a malformed data payload as an error, keeping the good frames", () => {
    const good = `data: ${encodeRuntimeEvent(TEXT[0] as RuntimeEvent)}\n`;
    const result = decodeSseChunk("", `${good}data: {oops\n`);
    expect(result.events).toEqual([TEXT[0]]);
    expect(result.error).toBeInstanceOf(RuntimeProtocolError);
  });

  it("yields EVERY good event around a poison line and reports, never throws", async () => {
    // The consumer sees the text on both sides of the bad line, and learns
    // about the loss. Throwing would either lose everything after the bad
    // frame, or (for a consumer that stops at `done`) be silently swallowed.
    const body = [
      `data: ${encodeRuntimeEvent(TEXT[0] as RuntimeEvent)}`,
      `data: ${encodeRuntimeEvent(TEXT[1] as RuntimeEvent)}`,
      `data: {"type":"quantum_flux"}`,
      `data: ${encodeRuntimeEvent(TEXT[2] as RuntimeEvent)}`,
    ].join("\n");
    const seen: RuntimeEvent[] = [];
    const errors: RuntimeProtocolError[] = [];
    for await (const event of readSseEvents(streamOf([body]), {
      onProtocolError: (e) => errors.push(e),
    })) {
      seen.push(event);
    }
    expect(seen).toEqual(TEXT);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RuntimeProtocolError);
  });

  it("does not throw when no sink is configured (the loss is simply unreported)", async () => {
    const body = `data: {"type":"quantum_flux"}\n`;
    const seen: RuntimeEvent[] = [];
    for await (const event of readSseEvents(streamOf([body]))) seen.push(event);
    expect(seen).toEqual([]);
  });
});

describe("readEventStream", () => {
  it("reads an NDJSON body to completion", async () => {
    const events: RuntimeEvent[] = [];
    for await (const event of readNdjsonEvents(streamOf([ndjson(TEXT)]))) events.push(event);
    expect(events).toEqual(TEXT);
  });

  it("reads an SSE body to completion", async () => {
    const events: RuntimeEvent[] = [];
    for await (const event of readSseEvents(streamOf([sse(TEXT)]))) events.push(event);
    expect(events).toEqual(TEXT);
  });

  it("emits a trailing event whose newline never arrived (stream cut mid-frame)", async () => {
    const payload = ndjson(TEXT).trimEnd();
    const events: RuntimeEvent[] = [];
    for await (const event of readNdjsonEvents(streamOf([payload]))) events.push(event);
    expect(events).toEqual(TEXT);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: RuntimeEvent[] = [];
    for await (const event of readNdjsonEvents(streamOf([ndjson(TEXT)]), {
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  it("stops reading once the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const body = streamOf([
      encodeRuntimeEvent(TEXT[0] as RuntimeEvent),
      encodeRuntimeEvent(TEXT[1] as RuntimeEvent),
    ]);
    const events: RuntimeEvent[] = [];
    for await (const event of readNdjsonEvents(body, { signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }
    expect(events).toHaveLength(1);
  });

  it("releases the reader lock when the consumer breaks out early", async () => {
    let released = false;
    let index = 0;
    const body: ByteStreamLike = {
      getReader: () => ({
        read: () => {
          if (index >= 3) return Promise.resolve({ done: true });
          const value = encoder.encode(encodeRuntimeEvent(TEXT[index] as RuntimeEvent));
          index += 1;
          return Promise.resolve({ done: false, value });
        },
        releaseLock: () => {
          released = true;
        },
      }),
    };
    for await (const event of readNdjsonEvents(body)) {
      expect(event.type).toBeTypeOf("string");
      break;
    }
    expect(released).toBe(true);
  });

  it("decodes a multi-byte character split across a chunk boundary", async () => {
    const payload = encodeRuntimeEvent({ type: "text_delta", text: "你好" });
    const bytes = encoder.encode(payload);
    // Cut inside the UTF-8 sequence of the first CJK char (3 bytes: e5 bd a0).
    const cut = bytes.indexOf(0xe5) + 1;
    const events: RuntimeEvent[] = [];
    for await (const event of readNdjsonEvents(
      byteStreamOf([bytes.slice(0, cut), bytes.slice(cut)]),
    )) {
      events.push(event);
    }
    // TextDecoder with `stream: true` holds the partial sequence back, so the
    // CJK text survives rather than decoding to replacement characters.
    expect(events).toEqual([{ type: "text_delta", text: "你好" }]);
  });
});
