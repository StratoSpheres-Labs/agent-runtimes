/**
 * Browser-side stream readers: SSE and NDJSON → `RuntimeEvent`.
 *
 * Both reframe one event per line and reuse `decodeRuntimeEventLine`, so the
 * malformed-line contract is identical to the backend's (`RuntimeProtocolError`,
 * never a silent drop) instead of being re-invented per consumer.
 *
 * Everything here is `fetch` + `ReadableStream` — no `EventSource` (it cannot
 * POST a prompt or carry headers, and this layer must work for WebSocket and
 * Electron IPC framing too), no Node builtins.
 */

import type { RuntimeEvent } from "../../events/runtime-event.js";
import type { RuntimeProtocolError } from "../../core/errors.js";
import { decodeRuntimeEventLine } from "../../wire.js";

/** SSE field terminator. Tolerates CRLF, which some proxies rewrite. */
const SSE_LINE = /\r?\n/;

/**
 * Result of reframing one chunk.
 *
 * `error` is carried alongside `events` rather than thrown from inside the
 * loop: a bad line used to abort the whole chunk and silently discard every
 * good event decoded before it — which, when a turn arrives in a single read,
 * means throwing away text the user already paid for. Now the good events
 * survive and the failure is still loud.
 */
export interface DecodedChunk {
  events: RuntimeEvent[];
  rest: string;
  /** First undecodable line in this chunk, if any. */
  error?: RuntimeProtocolError;
}

/** Coalesced NDJSON frames — split on every newline, drop the blank tail. */
export function decodeNdjsonChunk(buffered: string, chunk: string): DecodedChunk {
  const combined = buffered + chunk;
  const segments = combined.split("\n");
  const rest = segments.pop() ?? "";
  const events: RuntimeEvent[] = [];
  let error: RuntimeProtocolError | undefined;
  for (const segment of segments) {
    const line = segment.replace(/\r$/, "");
    if (line.length === 0) continue;
    try {
      events.push(decodeRuntimeEventLine(line));
    } catch (err) {
      // Keep decoding: one poison line must not cost us the rest of the chunk.
      error ??= err as RuntimeProtocolError;
    }
  }
  return error === undefined ? { events, rest } : { events, rest, error };
}

/**
 * Turn an SSE body into events.
 *
 * **One `data:` line is one event**, not one SSE *frame*. That is deliberate:
 * the wire contract is one JSON event per line (`encodeRuntimeEvent`), and
 * `examples/bff-sse.ts` writes `data: <line>\n` with no blank-line frame
 * terminator — so strict SSE coalescing would swallow an entire turn into one
 * multi-line `data:` field. Both shapes decode identically here: a blank line
 * is simply an ignored empty frame.
 *
 * Also ignored rather than surfaced as garbage: comment heartbeats
 * (`: keep-alive`), the other SSE fields (`event:`, `id:`, `retry:`), and the
 * `[DONE]` sentinel.
 */
export function decodeSseChunk(buffered: string, chunk: string): DecodedChunk {
  const combined = buffered + chunk;
  const segments = combined.split(SSE_LINE);
  const rest = segments.pop() ?? "";
  const events: RuntimeEvent[] = [];
  let error: RuntimeProtocolError | undefined;

  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/\r$/, "");
    // Empty frame (blank line) or comment / heartbeat.
    if (segment.length === 0 || segment.startsWith(":")) continue;
    const colon = segment.indexOf(":");
    const field = colon === -1 ? segment : segment.slice(0, colon);
    if (field !== "data") continue;
    if (colon === -1) continue;
    // A single optional space after the colon is part of the framing.
    let value = segment.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (value.length === 0 || value === "[DONE]") continue;
    try {
      events.push(decodeRuntimeEventLine(value));
    } catch (err) {
      // Same rule as NDJSON: keep the good frames, remember the bad one.
      error ??= err as RuntimeProtocolError;
    }
  }
  return error === undefined ? { events, rest } : { events, rest, error };
}

/** Anything with a `getReader()` — `Response.body`, an Electron IPC stream, a test double. */
export interface ByteStreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    releaseLock?(): void;
  };
}

/** Callback for lines that could not be decoded. Never thrown — see below. */
export type ProtocolErrorSink = (error: RuntimeProtocolError) => void;

export interface ReadEventStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Called for every undecodable line. The stream KEEPS GOING.
   *
   * Why not throw: a consumer that stops reading at the first bad frame loses
   * everything after it, and a consumer that stops at `done` (the normal
   * pattern) never observes a trailing error at all — so throwing turns one
   * poison line into either data loss or silence. Reporting and continuing
   * matches the library's own promise to fail open on a growing event set.
   */
  readonly onProtocolError?: ProtocolErrorSink;
}

/**
 * Read `body` to completion, feeding every chunk through `decode`.
 *
 * `signal` aborts the read (assistant-ui passes its `abortSignal` straight
 * through, so the composer's Stop button reaches the network layer).
 */
export async function* readEventStream(
  body: ByteStreamLike,
  decode: (buffered: string, chunk: string) => DecodedChunk,
  options?: ReadEventStreamOptions,
): AsyncGenerator<RuntimeEvent, void, undefined> {
  const signal = options?.signal;
  // Wrapped in a closure on purpose: `AbortSignal.aborted` flips mid-stream,
  // but TypeScript narrows a repeated `signal?.aborted === true` comparison
  // against the first one and would call the second one unreachable.
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const report = (error: RuntimeProtocolError | undefined): void => {
    if (error !== undefined) options?.onProtocolError?.(error);
  };
  try {
    for (;;) {
      if (aborted()) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const decoded = decode(buffered, decoder.decode(value, { stream: true }));
      buffered = decoded.rest;
      // Report BEFORE delivering: a consumer that stops reading at `done` (the
      // normal pattern) would otherwise never resume the generator, and the
      // loss would go unreported — which is the silence we are fixing.
      report(decoded.error);
      for (const event of decoded.events) yield event;
    }
    // A stream cut mid-line leaves a tail the decoder never saw a newline
    // for. Surface it only if it parses — a cancelled turn legitimately ends
    // with no trailing newline.
    const tail = buffered.trim();
    if (tail.length > 0) {
      const decoded = decode("", `${tail}\n`);
      report(decoded.error);
      for (const event of decoded.events) yield event;
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** SSE variant of {@link readEventStream}. */
export function readSseEvents(
  body: ByteStreamLike,
  options?: ReadEventStreamOptions,
): AsyncGenerator<RuntimeEvent, void, undefined> {
  return readEventStream(body, decodeSseChunk, options);
}

/** NDJSON variant of {@link readEventStream} (the `docs/frontend.md` default framing). */
export function readNdjsonEvents(
  body: ByteStreamLike,
  options?: ReadEventStreamOptions,
): AsyncGenerator<RuntimeEvent, void, undefined> {
  return readEventStream(body, decodeNdjsonChunk, options);
}
