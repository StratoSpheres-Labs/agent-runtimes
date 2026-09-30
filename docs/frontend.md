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
  `CreateSessionOptions` minus `onPermissionRequest` and `logger`
  (functions — they stay in the backend process).
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
> echoed in tool output. Entries arrive desensitized by default
> (`redacted: true`, credential shapes masked — pass `includeRawInputs`
> only for trusted first-party use). Never log `history()` results, never
> forward them to another model or service without explicit user consent,
> and prefer `limit`/`since` over full dumps.

## Steering: `run.send()` via `WireSendInput`

A run started with `allowMidRunInput: true` on a `midRunInput` runtime
(ACP only — claude print mode consumes just the initial stdin prompt,
verified live, so its runs reject `send()`) accepts follow-up input
while the turn streams. The frontend sends `WireSendInput`
(`{ runId, text }`, `src/wire.ts:1`) upstream — SSE POST, WebSocket
message, or Electron IPC — and the backend routes it to the live run's
`send()`:

```json
{ "runId": "sess_aaa:run1", "text": "actually use pnpm, not npm" }
```

Text-only: prompt images are not JSON-safe and stay backend-side.
Unknown `runId`s, finished runs, and runs without `allowMidRunInput`
reject loudly — the UI should surface the error, never retry silently.
`send()` is fire-and-forget (it never blocks the event stream); the
steered turn keeps emitting `text_delta` / `tool_*` / `done` as usual.

## Seeding: resume history without a native id

No CLI can inject messages into a fresh session (`seedMessages` is
rejected loudly everywhere) — all resume paths need a pre-existing
native session id. The caller-side pattern for "continue an old
conversation in a new session" is folding history into context text:

```ts
import { foldSeedMessages } from "@stratosphereslab/agent-runtimes";
const context = foldSeedMessages(savedTurns); // "User: …\nAssistant: …"
const run = await session.run(`${context}\n\nContinuing: ${question}`);
```

`foldSeedMessages` truncates each turn to the transcript budget and drops
images (text summary only). It is display-equivalent context, not a
restored session — tool state and approvals start over.

## Permission denials: `permission_denied` (observe-only)

When a harness tool gate auto-decides against a call, the denial
surfaces as `permission_denied` (`{id, toolName?, reason?, kind?}`).
Unlike `permission_request` there is nothing to answer — the decision
was already made. `id` joins with the `tool_started`/`tool_finished`
of the same call, so the UI can render "Write blocked: needs manual
approval" inline instead of silence. Unknown to old consumers it fails
open like any new discriminant (see Versioning below).

Shapes by runtime (both verified live):

- claude: `system/permission_denied` (`tool_name`, `tool_use_id`,
  `decision_reason`/`message`, `decision_reason_type`) — print mode
  auto-decisions. `kind` is the native class (e.g. `"safetyCheck"`).
- opencode: `tool_use` with `state.status: "error"` whose error string
  starts with a refusal prefix — `"The user rejected permission to use
this specific tool call."` (headless ask auto-reject, `kind:
"reject"`, full text kept) or `"The user has specified a rule which
prevents you from using this specific tool call."` (explicit deny
  rule, `kind: "deny"`, trailing ruleset JSON stripped). Ordinary tool
  errors never match, so `tool_finished{error:true}` without a
  `permission_denied` sibling means "failed", not "blocked".

## Structured output: still `text_delta`, just parseable

`outputSchema` (codex `--output-schema`, claude `--json-schema`) raises
the hit rate, it does not change the wire type: the constrained answer
arrives as `text_delta` (claude surfaces the `StructuredOutput` tool
input as text; codex as the final message) and the frontend
`JSON.parse`s it. Always parse defensively — a schema raises
compliance, never guarantees it. Codex rejects non-strict schemas
(`additionalProperties: false` required, verified live: otherwise the
turn fails before the first token).

## Turns: drain run N before starting run N+1

The native session id (resume) is captured from run N's event stream, so
a run N+1 started while run N was never drained to `done` would silently
open a **fresh** upstream session and lose context. The library refuses
this loudly (`RuntimeSessionError`, "not drained to done") instead —
drain to `done` first, or open a fresh session on purpose. The only
exception is a run drained to `done` with no id in it (the CLI died
before minting one): a fresh start is provably safe there and allowed.

## Queue: `run(prompt, { queue: true })` waits instead of rejecting

Fire `run()` calls back-to-back without babysitting drains: queued turns
dispatch FIFO once the previous turn's `done` is observed. Same drain
requirement as above — queue decouples _issue_ time from _drain_ time, it
does not eliminate draining (drain directly or run one background pump
over all runs). Details: aborted `signal` dequeues before dispatch (never
cancels a live turn — use `cancel()` for that); `cancel()` keeps the
queue, `close()` rejects everything still queued; queued prompts live in
memory only (a host crash drops the queue, completed turns survive in the
run journal).

## Error codes: machine-readable, never string-match

Every `error` event carries `error.code` — switch on it, never on
`error.message` (messages are human prose and may change):

| code                       | meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `TIMEOUT`                  | turn exceeded its timeout (stdio runs and ACP turns agree)                                 |
| `STALL`                    | no event for `stallTimeoutMs` (live but silent agent); turn cancelled, `done` follows      |
| `NON_ZERO_EXIT`            | child died with a non-zero code, no turn `done` seen                                       |
| `PROCESS_ERROR`            | spawn failure or other process-level fault (not a timeout)                                 |
| `TURN_FAILED`              | ACP prompt round-trip failed (not a timeout)                                               |
| `STOP_REASON`              | ACP turn ended with a non-`end_turn` stop reason                                           |
| `SEND_FAILED`              | ACP mid-run `send()` follow-up failed (turn keeps going)                                   |
| `PARSER_ERROR`             | a parser threw mid-stream; the stream stays alive                                          |
| `INVALID_JSON`             | one unparseable line; the stream stays alive                                               |
| `UNKNOWN_EVENT`            | known JSON, unknown `type`; surfaced, never dropped silently                               |
| `BUFFER_OVERFLOW`          | queue (10k events) or parser buffer (4MB) flooded; data events dropped, `done` still flows |
| `STDIN_WRITE_FAILED`       | prompt pipe broken (agent exited early)                                                    |
| `STDERR`                   | raw-mode stderr line (parser mode ignores stderr)                                          |
| `PERMISSION_ANSWER_FAILED` | interactive permission answer failed; the turn is still waiting — retry or cancel          |

`permission_denied` is a separate event (not an `error` code): `kind`
`"deny"` = explicit rule, `"reject"` = headless auto-reject (opencode);
claude carries the native class (e.g. `"safetyCheck"`).

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
