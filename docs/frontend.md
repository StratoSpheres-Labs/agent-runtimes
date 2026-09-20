# Frontend Wire Contract

How a Web or Electron UI consumes `agent-runtimes` without importing Node
internals. Status: types + framing only — no HTTP server is shipped (it gets
designed against the first real consumer: a daemon or an Electron main
process).

## Rule 0: never import the library in the browser

The package spawns child processes (`node:child_process`, `node:fs`). It
runs in Node ≥ 20: a backend-for-frontend, a daemon, or an Electron **main**
process. The renderer (or browser tab) only ever sees JSON described below;
it imports `agent-runtimes` for **types** at most (`import type`).

## What crosses the wire

- **Events**: `RuntimeEvent` — every payload field is `JsonValue`
  (`string | number | boolean | null | arrays | plain objects`). No
  functions, class instances, `undefined`, or BigInts can hide in
  `input`/`output`/`cause`/`raw` — the type system rejects them at the
  producer, so `JSON.stringify` never throws or silently drops data.
- **Session options**: `WireCreateSessionOptions` =
  `CreateSessionOptions` minus `onPermissionRequest` (a function — it stays
  in the backend process).
- **Health**: `DoctorReport` / `SessionRecord` / `RuntimeInfo` are plain DTOs.

What never crosses: `onPermissionRequest` handlers, `PermissionRequest`
callback objects, `ChildProcess` handles, `EventStream` instances. The
interactive permission flow stays backend-side: the backend holds the
handler, forwards `permission_request` events downstream, and answers via
`respondToPermission`.

## Framing: NDJSON

One event per line. The backend sends `encodeRuntimeEvent(event)` (JSON +
`\n`); the frontend splits the byte stream on `\n` and runs each line
through `decodeRuntimeEventLine` (throws `RuntimeProtocolError` on garbage).
Suggested mappings:

- **SSE**: `data: <line>\n\n` per event.
- **WebSocket**: one text message per line.
- **Electron IPC**: `structuredClone` of the parsed event, or the raw line.

Validate untrusted input with `isRuntimeEvent` before casting.

## Run attribution: `runId`

Every event a Run emits carries an optional `runId` (`<sessionId>:run<N>`,
e.g. `sess_mf2x9k1a_q7w3ze:run2`). Group by `runId` to reassemble one turn
from an interleaved stream:

```json
{"type":"text_delta","text":"你好","runId":"sess_aaa:run1"}
{"type":"text_delta","text":"Hello","runId":"sess_bbb:run1"}
{"type":"done","runId":"sess_aaa:run1"}
{"type":"done","runId":"sess_bbb:run1"}
```

Notes:

- `runId` is stamped by the Run, never by parsers — parser output has no
  `runId`. It is optional on the wire: old events without it still decode.
- `session_started.sessionId` is the **native** agent session id (opencode
  `sessionID`, codex `thread_id`), not our session id. Our session id is the
  `runId` prefix before the colon.

## Thinking: `reasoning_delta`

The agent's thinking summary arrives as `reasoning_delta` — never mixed
into `text_delta`, never filed as tool calls:

| CLI      | Native shape                                                   | Notes                                                                                                 |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| opencode | `{"type":"reasoning","part":{"type":"reasoning","text":"…"}}`  | only with `--thinking` (adapter passes it for JSON); empty text (encrypted-only reasoning) is dropped |
| claude   | `assistant` content block `{"type":"thinking","thinking":"…"}` | `signature` never forwarded; empty thinking (`display: omitted`) is dropped                           |
| codex    | `item.completed` with `item.type: "reasoning"`                 | previously surfaced as fake `tool_started`/`tool_finished`; `item.started` reasoning is ignored       |
| ACP      | `agent_thought_chunk`                                          | empty chunks dropped                                                                                  |

Render it dimmed/collapsed, or ignore it entirely — it is display-only
and never resumable input. Like `runId`, it is opt-in growth under the
versioning rule: old consumers that don't know the discriminant fail open.

## History: `session.history()` reads native transcripts

`history()` folds the CLI's own transcript store (opencode `opencode.db`,
codex rollout JSONL, Claude transcript JSONL) into compact
`TranscriptEntry[]` — one entry per turn, tool calls compressed to one
line, thinking dropped. Nothing is persisted by the library (read-through
only); missing stores, schema drift, and old node (opencode needs
`node:sqlite`, i.e. node ≥ 22.5) all fail open to `[]`.

> Privacy: transcripts may contain user-pasted secrets or credentials
> echoed in tool output. Never log `history()` results, never forward them
> to another model or service without explicit user consent, and prefer
> `limit`/`since` over full dumps.

## Cancellation: `cancel()` always ends with `done`

`run.cancel()` kills the process **and** pushes a terminal `done`
(carrying the kill signal, e.g. `SIGTERM`) before closing the stream —
consumers can tell "cancelled" apart from "stream cut". `run.close()`
alone is silent teardown and emits nothing.

## Versioning

`RuntimeEvent` only grows by new `type` discriminants or new optional
fields. Consumers must ignore unknown event types (fail open, surface a
generic row) rather than throw — the discriminant set is the compatibility
surface.
