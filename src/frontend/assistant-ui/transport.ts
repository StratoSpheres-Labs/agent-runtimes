/**
 * HTTP transport: the frontend half of the BFF slice in
 * `docs/dev/getting-started/bff.md`.
 *
 * The backend holds the `Session`/`Run` and streams `RuntimeEvent`s; this
 * module owns the four calls a chat UI makes and the rules that go with them:
 *
 * - **one active run per session** — a second turn while one streams rejects
 *   loudly (409 on the wire) instead of silently starting a parallel run,
 * - **drain before the next turn** — the native session id is captured from
 *   run N's stream, so an undrained run N+1 would resume a *fresh* upstream
 *   session and silently lose context,
 * - **cancel ends with `done`** — the UI stops on the terminal `done`, not on
 *   a closed socket,
 * - **switch on `error.code`, never `error.message`**.
 *
 * Endpoint shape is configurable (`endpoints`) because every BFF names its own
 * routes; the defaults match `examples/bff-sse.ts`.
 */

import { RuntimeProtocolError } from "../../core/errors.js";
import type { RuntimeEvent } from "../../events/runtime-event.js";
import type { WireRespondPermission, WireSendInput } from "../../wire.js";
import { readNdjsonEvents, readSseEvents } from "./stream.js";

export interface RuntimeTransportEndpoints {
  /** Streams a turn. Receives `{ prompt }` as a JSON POST body. */
  readonly turn: string;
  /** Stops the live turn. Receives `{ session?, runId? }`. */
  readonly cancel?: string;
  /** Answers a pending `permission_request`. Receives `WireRespondPermission`. */
  readonly permission?: string;
  /** Mid-run steering (`WireSendInput`) — ACP runtimes only. */
  readonly send?: string;
}

export interface RuntimeTransportOptions {
  /** Route table; `turn` is required, the rest default to `examples/bff-sse.ts`'s shape. */
  readonly endpoints: RuntimeTransportEndpoints;
  /** Injected for tests / Electron IPC; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Thread/session key forwarded to the backend so it can reuse a `Session`. */
  readonly sessionId?: string;
  /** Extra headers (auth, tracing). Never carries agent secrets — those stay backend-side. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * `"sse"` (default, `data: <ndjson>`) or `"ndjson"` (bare lines).
   * Both reframe identically — see `stream.ts`.
   */
  readonly framing?: "sse" | "ndjson";
  /**
   * Called for every line the stream could not decode (corrupt JSON, or an
   * event type this version does not know). The turn KEEPS GOING — failing
   * open is what makes a newer CLI usable against an older adapter — so this
   * is the ONLY way to learn that content was dropped. Wire it to a log or a
   * badge; without it the loss is invisible.
   */
  readonly onProtocolError?: (error: RuntimeProtocolError) => void;
}

export interface RuntimeTurn {
  /** `<sessionId>:run<N>`, learned from the first event that carries it. */
  readonly runId: string | undefined;
  readonly events: AsyncGenerator<RuntimeEvent, void, undefined>;
}

export interface RuntimeTransport {
  /** POST a prompt and stream the turn's events. Rejects (loudly) if a run is already live. */
  startTurn(prompt: string, options?: { signal?: AbortSignal }): Promise<RuntimeTurn>;
  /** Ask the backend to stop the live turn. It ends the stream with `done`. */
  cancel(runId?: string): Promise<void>;
  /** Answer a pending `permission_request` (`onRespondToToolApproval`). */
  respondToPermission(id: string, optionId: string): Promise<void>;
  /** Mid-run steering — ACP runtimes only; stdio CLIs reject it (400). */
  send(runId: string, text: string): Promise<void>;
}

/** A successful streaming response — `Response` with a non-null `body`. */
type TurnResponse = Response;

function jsonHeaders(extra?: Readonly<Record<string, string>>): Record<string, string> {
  return { "content-type": "application/json", ...(extra ?? {}) };
}

async function readErrorEnvelope(response: Response): Promise<string> {
  // Never surface the raw body — a backend may have included a path or a
  // fragment of a prompt in it. The status line plus our own context is
  // enough for the UI to branch on.
  const body = await response.text().catch(() => "");
  const hint = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return `${String(response.status)} ${response.statusText}${hint.length > 0 ? ` — ${hint}` : ""}`;
}

export function createRuntimeTransport(options: RuntimeTransportOptions): RuntimeTransport {
  const { endpoints, sessionId } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new TypeError("createRuntimeTransport(): no fetch available — pass options.fetch");
  }
  if (endpoints.turn.length === 0) {
    throw new TypeError("createRuntimeTransport(): endpoints.turn is required");
  }

  async function post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await doFetch(url, {
      method: "POST",
      headers: jsonHeaders(options.headers),
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      throw new RuntimeProtocolError(`${url} failed: ${await readErrorEnvelope(response)}`, {
        command: url,
      });
    }
    return response;
  }

  /** Wrap the body in the right reader, or reject loudly when there is no body. */
  async function* events(
    response: TurnResponse,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent, void, undefined> {
    if (response.body === null) {
      throw new RuntimeProtocolError("turn response had no body — nothing to stream", {
        command: endpoints.turn,
      });
    }
    const readOptions = {
      ...(signal !== undefined ? { signal } : {}),
      ...(options.onProtocolError !== undefined
        ? { onProtocolError: options.onProtocolError }
        : {}),
    };
    const reader =
      options.framing === "ndjson"
        ? readNdjsonEvents(response.body, readOptions)
        : readSseEvents(response.body, readOptions);
    yield* reader;
  }

  return {
    async startTurn(prompt: string, startOptions): Promise<RuntimeTurn> {
      if (prompt.length === 0) {
        throw new TypeError("startTurn(): prompt must not be empty");
      }
      const response = await post(
        endpoints.turn,
        { prompt, ...(sessionId !== undefined ? { session: sessionId } : {}) },
        startOptions?.signal,
      );

      // `runId` is only known once the stream starts, so it is learned from
      // the first event that carries it and read back off `turn.runId`.
      let runId: string | undefined;
      async function* tracked(): AsyncGenerator<RuntimeEvent, void, undefined> {
        for await (const event of events(response, startOptions?.signal)) {
          if (event.runId !== undefined) runId = event.runId;
          yield event;
        }
      }
      return {
        get runId(): string | undefined {
          return runId;
        },
        events: tracked(),
      };
    },

    async cancel(runId?: string): Promise<void> {
      if (endpoints.cancel === undefined) {
        throw new TypeError("cancel(): endpoints.cancel not configured");
      }
      await post(endpoints.cancel, {
        ...(sessionId !== undefined ? { session: sessionId } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
    },

    async respondToPermission(id: string, optionId: string): Promise<void> {
      if (endpoints.permission === undefined) {
        throw new TypeError("respondToPermission(): endpoints.permission not configured");
      }
      const payload: WireRespondPermission = { id, optionId };
      await post(endpoints.permission, payload);
    },

    async send(runId: string, text: string): Promise<void> {
      if (endpoints.send === undefined) {
        throw new TypeError("send(): endpoints.send not configured");
      }
      const payload: WireSendInput = { runId, text };
      await post(endpoints.send, payload);
    },
  };
}
