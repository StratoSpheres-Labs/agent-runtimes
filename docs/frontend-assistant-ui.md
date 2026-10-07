# assistant-ui Integration

How a React chat UI consumes `agent-runtimes` through
[assistant-ui](https://www.assistant-ui.com). Companion to
[frontend.md](./frontend.md) — that page defines the wire contract (event
shapes, error codes, framing); this one defines the adapter that implements
it, so you do not rewrite the same fold in every project.

Ships as a separate, browser-safe entry point:

```ts
import {
  createThreadStore,
  createExternalStoreAdapter,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

> **Import from the subpath, never the package root.** `src/index.ts` pulls in
> `node:child_process`; a bundler resolving the root entry for a renderer will
> fail on the first `node:` specifier. The subpath is built separately
> (`platform: "browser"`, `target: "es2022"`) and `dist/assistant-ui.js` has
> **zero imports** — no builtins, no runtime dependencies. A test walks the
> import graph and fails the build if that changes.

## Layers

```
Agent CLI → Transport → Parser → BFF (Session/Run) → SSE → stream.ts
                                                              ↓
                                                         fold.ts  RuntimeEvent → parts + status
                                                              ↓
                                    ThreadStore / ChatModelAdapter → assistant-ui runtime hook
```

| Module              | Responsibility                                                          |
| ------------------- | ----------------------------------------------------------------------- |
| `types.ts`          | Local structural mirror of assistant-ui's shapes (erased at build time) |
| `fold.ts`           | The reducer: `RuntimeEvent` → cumulative parts + message status         |
| `stream.ts`         | SSE / NDJSON → `RuntimeEvent[]`                                         |
| `transport.ts`      | `fetch` wrapper: start turn, cancel, approve, steer                     |
| `chat-model.ts`     | `ChatModelAdapter` for `useLocalRuntime`                                |
| `external-store.ts` | `ThreadStore` + `ExternalStoreAdapter` for `useExternalStoreRuntime`    |

Everything above `fold.ts` is a thin shell, which is why the fold lives here
and not in a runtime adapter: it is agent-agnostic (Rule 6) and knows nothing
about processes (Rule 4).

## Picking a runtime hook

| Hook                      | Use when                                                                  | Entry                                              |
| ------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `useExternalStoreRuntime` | Approvals and server interrupts — **the usual choice for a coding agent** | `createThreadStore` + `createExternalStoreAdapter` |
| `useLocalRuntime`         | assistant-ui should own message state and the backend stays out of it     | `createChatModelAdapter`                           |

The external-store path is the default recommendation for a local agent CLI
because two of its features are **real server calls**, not client state:

- `permission_request` → `onRespondToToolApproval` round-trips to
  `run.respondToPermission`, so Allow / Deny unblocks the agent,
- `onCancel` is a server interrupt; the stream ends with a terminal `done`.

Neither runtime can honestly offer edit / regenerate / branching yet — see
[Not supported](#not-supported-edit-regenerate-branching) before wiring them.

## Event → assistant-ui mapping

| `RuntimeEvent`       | Result                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `session_started`    | `nativeSessionId` → `metadata.custom` (the resume handle); no visible part                       |
| `text_delta`         | Appended to the trailing text part                                                               |
| `reasoning_delta`    | Appended to the trailing reasoning part                                                          |
| `tool_started`       | `tool-call` part: `toolCallId`, `toolName`, `args`, `argsText`; no `result` → renders as running |
| `tool_finished`      | Fills `result` / `isError` on that part; also settles any pending gate                           |
| `permission_request` | `approval: { id, prompt, options }` on the tool part + message status `requires-action`          |
| `permission_denied`  | `approval.approved = false` + `result: { error, isError: true }` — observe-only, nothing waits   |
| `error`              | Message status `incomplete` / `reason: "error"`, carrying `{ code, message }`                    |
| `usage`              | `metadata.steps[].usage` (tokens) and `metadata.custom`                                          |
| `done`               | `complete` / `stop`, or `incomplete` / `cancelled` when the turn was cancelled                   |
| anything else        | Ignored but **recorded** — see [Observability](#observability-what-the-adapter-tells-you)        |

### Three assistant-ui invariants the fold exists to satisfy

1. **Snapshots, never deltas.** `ChatModelRunResult.content` is REPLACED on
   every yield, so yielding a delta flickers. `snapshot()` always returns the
   full cumulative part list.
2. **Only the last part may be `running`.** An empty trailing text part marks
   the _previous_ part complete — so `fold.ts` never creates a text or
   reasoning part without content, and `emit()` throws rather than corrupt a
   stream.
3. **Status is derived, never assigned.** `currentStatus()` recomputes from
   (error, cancelled, pending approvals, done), most specific first, so the
   reducer cannot drift out of sync with what it already folded.

### Interleaving is preserved

A coding agent's output is not "some text, then some tools". The fold keeps
emission order, so `reasoning → tool → text` renders in that order instead of
being flattened into one text blob:

```
[reasoning] [tool-call] [text] [tool-call] [text]
```

## Observability: what the adapter tells you

Everything below is in `ThreadStoreSnapshot` and on each assistant message's
`metadata`. The point is that **nothing fails silently** — the failure modes a
chat UI hides (dropped content, "empty thread" that is really a dead backend, a
turn that never settles).

### `loadState` — why the thread is empty

```
{ type: "idle" }                              nothing sent yet
{ type: "loading" }                           a turn is in flight, no event yet
{ type: "ready" }                             there is content
{ type: "error", error }                      the backend refused / is unreachable
```

Without this, "you have no messages", "the first turn is still starting" and
"the BFF is down" all render as the same empty thread.

### `runState` — `cancelling` is not `streaming`

```
{ type: "idle" } | { type: "streaming" } | { type: "cancelling" } | { type: "error", error }
```

After the user presses Stop the agent keeps emitting until its terminal
`done`. Reporting "generating" for that whole window is wrong, so cancelling
is its own state. `isRunning` stays true across both (assistant-ui needs it to
keep the Stop button put).

### `unhandledEvents` — content we could not project

```ts
// Fold level (direct library callers): snapshot.unhandledEvents
// Wire level (a newer CLI sends an unknown type): transport's onProtocolError
transport: createRuntimeTransport({
  endpoints: { turn: "/turn" },
  onProtocolError: (err) => console.warn("dropped a line:", err.message),
});
```

Wire behaviour, precisely: a line that cannot be decoded (corrupt JSON, or an
event type this version does not know) is **skipped and the stream keeps
going** — failing open is what lets a newer CLI work against an older adapter.
Both sides of the bad line are delivered; only the bad line is lost. The fold
never stores the offending payload: it is untrusted wire data and could echo a
prompt fragment, so only the type name and a count are kept.

> The decoders used to **throw** mid-chunk, which silently discarded every
> event already decoded in that chunk — and a single read can carry a whole
> turn, so one poison line cost real text. That is fixed, and
> `tests/assistant-ui-stream.test.ts` pins it.

### `droppedParts` and `metadata.timing`

`droppedParts` is non-zero when the `MAX_TURN_PARTS` cap evicted content — the
transcript on screen is incomplete and the UI should say so.
`metadata.timing` is a ready-made assistant-ui `MessageTiming`
(`streamStartTime`, `firstTokenTime`, `totalStreamTime`, `tokenCount`,
`tokensPerSecond`, `totalChunks`, `toolCallCount`), computed from data the fold
already had. Note the units: `streamStartTime` is an epoch, the other two are
durations in ms.

## The `data-*` extension channel

assistant-ui's part union has an open channel for structured cards. Two
spellings exist upstream, and which one is valid depends on the runtime:

| Part                                     | Valid for                                       |
| ---------------------------------------- | ----------------------------------------------- |
| `{ type: "data-<name>", data }`          | `useExternalStoreRuntime` (`ThreadMessageLike`) |
| `{ type: "data", name: "<name>", data }` | `useLocalRuntime` (`ChatModelRunResult`)        |

`AssistantTurn.emit` / `ThreadStore.emit` accept either; the chat-model
adapter rewrites the prefixed form into the named one on the way out, because
the local-runtime union has no other spelling.

```ts
store.emit({ type: "data-spec-sheet", data: { title: "Q3", rows: rows.length } });
```

This is the intended home for anything the agent produces that is not text: a
report, a spec sheet, sources, retrieved chunks, a scored verdict. It is a
frontend-side channel — no `RuntimeEvent` was added, and `src/core` is
untouched.

## Tool arguments

assistant-ui types `args` as a JSON **object**, while `tool_started.input` is
a `JsonValue` (possibly a string or array). Objects pass through unchanged;
anything else is wrapped under a stable `value` key, and the raw JSON always
stays available as `argsText` (which upstream requires, and which doubles as
the streaming-args text for renderers).

## Permissions: the approval gate

`permission_request` becomes a pending `approval` on the tool part, and the
message status flips to `requires-action` — which is exactly what assistant-ui
needs to render Allow / Deny on the tool card (`ToolFallback` does it out of
the box).

- `options[].optionId` → `approval.options[].id`
- `options[].kind` is normalized to assistant-ui's hyphenated set
  (`allow_once` → `allow-once`); unknown kinds pass through (the union is open)
- An **empty** options list omits `options` entirely, so assistant-ui renders
  its plain Allow / Deny pair instead of an unclickable list
- The click comes back through `onRespondToToolApproval({ approvalId, approved, optionId })`
  → `transport.respondToPermission(id, optionId)` → `WireRespondPermission`
  → the backend's `run.respondToPermission(id, optionId)`

`optionId` is never client-invented: it must be one the event offered.

A denial settles the gate with `approved: false` and synthesizes an error
result, so the card reads "blocked" rather than silently doing nothing. The
`ThreadStore` retains its fold after the turn drains precisely so a click that
arrives _after_ `done` still updates the card. If the answer cannot be
delivered, the gate is **re-opened** (`reopenApproval`) and the error is
rethrown — the card never sits on "allowed" while the agent is still parked.

`permission_denied` needs no answer — the harness already decided. It renders
as a denial, never as a gate.

### The `id` a UI answer must carry, and where it breaks

`WireRespondPermission.id` must be the `permission_request.id` the UI was
shown, and the backend must be able to resolve it. That correlation exists
**only where the transport supplies a request id**:

| Runtime             | `permission_request` event? | `PermissionRequest.id`?                                                                | UI round trip?                     |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `claude`            | yes (`AskUserQuestion`)     | yes (the `tool_use_id`)                                                                | **yes**                            |
| `opencode-acp`      | no                          | no — `session/request_permission` has no id, and `AcpRun` has no `respondToPermission` | **no** — answer inside the handler |
| `opencode`, `codex` | no                          | —                                                                                      | no                                 |

So the gate is a **claude-only** feature today, and both examples answer ACP
inline (with a `console.warn`) rather than inventing a key that
could never match. A backend that cannot correlate must reject the answer
loudly — an invented key 404s on every click, which is exactly the bug this
table exists to prevent.

## Not supported: edit, regenerate, branching

`onEdit`, `onReload` and `onResume` are **absent** from the adapter, and
assistant-ui reads an absent callback as "this app cannot do that" — so the
Edit and Regenerate buttons do not appear. That is deliberate, because wiring
them would be a lie: every resume path in every supported CLI only _extends_ a
session, with no flag to truncate a prefix (`docs/PARITY.md` §4, "Truncating a
conversation"). "Edit and re-ask" would send only the new text to an agent
still holding the old transcript; "regenerate" would append a second answer
instead of replacing the first. Both look right in the UI and are wrong about
the agent's context.

`setMessages` is wired (so a host that _does_ own truncation can drive branch
switching), but the adapter never produces alternative branches, so
`BranchPicker` has nothing to switch between.

If you need a genuine rewind, start a fresh `Session` — the store takes a
`sessionId`, so a new key is a new upstream session.

## Not supported: nested sub-agent conversations

`history()` can nest sub-agent transcripts under the tool call that dispatched
them (`HistoryOptions.includeSubAgents`, gated on
`RuntimeCapabilities.subAgents`; opencode only so far — see
[`PARITY.md` §4](./PARITY.md)). The assistant-ui adapter does **not** fold them
into `ToolCallMessagePart.messages` yet, so a sub-agent's turns are not rendered
inside the tool card that spawned them.

Two things are missing, in order:

1. **A BFF history route.** The transport's four routes cover a turn only; there
   is nothing to read a transcript back through.
2. **The fold.** Nesting transcript entries into `messages` needs the same care
   as the top-level projection: a sub-agent's tool calls are _not_ part of the
   parent run, so they must not inherit its `runId`, its approval gate, or its
   `status`. Getting that wrong puts a child's "Allow" button in a card whose
   `permission_request` was never emitted for that run.

Until both land, do not hand-roll it in a host: the correlation rule (drop an
unlinkable child rather than guess a parent) is the part that is easy to get
wrong and impossible for a consumer to detect.

## The BFF routes the transport expects

| Route              | Body                    | Purpose                                 |
| ------------------ | ----------------------- | --------------------------------------- |
| `POST /turn`       | `{ prompt, session? }`  | Stream the turn (SSE or NDJSON)         |
| `POST /cancel`     | `{ session?, runId? }`  | Stop the live turn; it ends with `done` |
| `POST /permission` | `WireRespondPermission` | Answer a pending `permission_request`   |
| `POST /send`       | `WireSendInput`         | Mid-run steering (ACP runtimes only)    |

Only `turn` is required; the rest throw a `TypeError` when unconfigured, so a
misconfigured app fails loudly instead of silently dropping the action.

`examples/bff-assistant-ui.ts` implements exactly this table
(`pnpm example:bff-ui`, then open http://localhost:3000), and
`tests/bff-assistant-ui.test.ts` covers it against a stub session — no CLI
needed. It also serves `dist/assistant-ui.js` so the demo page can `import` the
bundle as a plain ES module.

> Earlier revisions of this file pointed at `examples/bff-sse.ts` for this
> table. That was wrong: it serves `GET /events?prompt=…` over `EventSource`,
> which the transport never calls. Its `/send`, `/permission` and `/cancel`
> routes do match; only the turn route differs. Both examples are still useful
> — `bff-sse.ts` for reading raw SSE, `bff-assistant-ui.ts` for the adapter.

Framing is `"sse"` by default (`data: <line>` per event). Set
`framing: "ndjson"` for bare lines. **One `data:` line is one event**, not one
SSE frame — strict SSE coalescing would swallow an entire turn, because
`encodeRuntimeEvent` is one-event-per-line and the demo omits the blank-line
frame terminator. Comments, `event:`/`id:`/`retry:` fields and the `[DONE]`
sentinel are all ignored.

## Wiring it up

### External store (recommended)

```tsx
"use client";
import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useAuiState,
} from "@assistant-ui/react";
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";

export function AgentRuntimeProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(
    () =>
      createThreadStore({
        transport: createRuntimeTransport({
          endpoints: {
            turn: "/api/agent/turn",
            cancel: "/api/agent/cancel",
            permission: "/api/agent/permission",
            send: "/api/agent/send",
          },
          sessionId: "default",
        }),
      }),
    [],
  );
  const runtime = useExternalStoreRuntime(createExternalStoreAdapter(store));
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

`ThreadStore` is framework-free (`getSnapshot` / `subscribe`), so it also
binds to zustand or a plain `useState` if you do not want assistant-ui's
conversion layer. What you get: streaming, thinking, tool cards, the approval
gate, cancel, usage/cost, and the `data-*` channel. What you deliberately do
**not** get: Edit / Regenerate / branching (see above).

### Local runtime

```tsx
const runtime = useLocalRuntime(
  createChatModelAdapter({
    transport: createRuntimeTransport({ endpoints: { turn: "/api/agent/turn" } }),
  }),
);
```

assistant-ui owns message state here. Note the trade-off: you get assistant-ui's
own composer queue and branching _plumbing_, but since `onEdit`/`onReload` are
never answered by a local CLI's non-truncating resume, treat "regenerate" as
"ask again in a new session" (see [Not supported](#not-supported-edit-regenerate-branching)).

### Thread list from the session store

`listSessionRecords()` (the session store) gives you id / nativeId / cwd /
model / updatedAt — enough to back a `RemoteThreadListAdapter` with a first-user-
message as the title. Not shipped here: the store is documented as a resume
_hint_ cache, so treat its contents as a hint, never as the source of truth.

## Rules that survive the mapping

- **One active run per session.** `store.send()` rejects with
  `RuntimeSessionError` while a turn streams; the backend answers `409`. Drain
  to `done` first, or resume silently opens a fresh upstream session and loses
  context ([frontend.md](./frontend.md) §Turns).
- **Cancel ends with `done`.** A cut stream (network drop, unmount) settles as
  `incomplete` / `cancelled` rather than leaving the message stuck on
  `running`.
- **Two different failure channels, two different contracts.** An `error`
  _event_ carries the 14-code taxonomy (`status.error.code`,
  `metadata.custom.errorCode`) — switch on that. But a failure to get the
  stream at all (the turn route answering `409` because a run is already live,
  a `500`, a network drop) arrives as a **thrown** `RuntimeProtocolError` /
  `RuntimeSessionError` from `store.send()`, and `RuntimeError` has **no
  `code` field** — only `message` + `context`. There is no taxonomy there by
  design, so branch on what you can actually observe:
  `err instanceof RuntimeSessionError` (a turn is already streaming) versus a
  `RuntimeProtocolError` (the backend refused). The HTTP status is inside the
  message. Do not string-match it; if you need machine-readable transport
  failures, that taxonomy does not exist yet.
- **Switch on `error.code`, never `error.message`** — for error _events_. The code lands in
  `status.error.code` and in `metadata.custom.errorCode`.
- **Error envelopes are truncated** at 200 characters by the transport — a
  backend body may echo a prompt fragment or a filesystem path.
- **`ThreadStore` does not filter by `runId`.** Each `startTurn` is its own
  POST, so one turn's stream can only carry that turn's events — but if you
  point the store at a _shared_ multiplexed stream, build the turn yourself
  with `createAssistantTurn({ runId })`, which filters per run and still
  accepts unstamped events (old payloads).

## Versioning

Two independent directions, both protected:

- `RuntimeEvent` only grows discriminants, and an unknown one cannot break an
  older adapter at either layer: the wire reader fails open (skips the line,
  keeps the rest of the chunk, routes it to `onProtocolError`) and the fold
  ignores and records it. Both are covered in
  [Observability](#unhandledevents--content-we-could-not-project).
- assistant-ui's part unions only grow fields. We ship **local structural
  types** rather than importing theirs, and
  `tests/assistant-ui-conformance.test.ts` assigns what we emit to the real
  `@assistant-ui/core` types — if upstream moves a field, `pnpm typecheck`
  fails there rather than in a consumer's app.

One boundary is deliberately permissive: `setMessages` accepts
`AuiInboundMessage` (content `string | readonly unknown[]`) because branch
switching hands back messages assistant-ui produced itself, which may carry
parts this package never emits. They are stored and re-broadcast uninspected.
That is the only cast in the adapter.

## Coverage

assistant-ui's element catalogue splits three ways:

- **Driven by the parts above** — Thread, Message, Markdown, Reasoning, Tool
  call / group / fallback / failure, Code diff, Terminal block, Data table,
  Approval card, Permission grant, Question flow, Guardrail notice, Stopped
  run, Connection state, Error state, Cost meter (from `usage.costUsd`),
  Model selector (from `models()`), Reasoning effort, Context display,
  Thread list, MCP config dialog.
- **Driven by the `data-*` channel** — Spec sheet, Report, Sources, Inline
  citation, Retrieval chunks, Recommendation card, Score breakdown, Todo list,
  Chart, Map, Memory, File tree, Subagent list.
- **Not covered by this library** — Edit a sent message, Regenerate with,
  Message branches and Checkpoints (all need conversation truncation, which no
  CLI supports — see above), Trace waterfall (we have run-level events, not
  spans), Flow graph, Computer use, Schedule, and cross-run analytics
  (Activity / Heat graph — the run journal has the events, but indexing them is
  your backend's job).

And one thing that is easy to misread: the **approval gate is claude-only**
today, because it is the only runtime that emits `permission_request` with a
correlatable id.

## Related

- [frontend.md](./frontend.md) — the wire contract this adapter implements
- [bff.md](./dev/getting-started/bff.md) — the BFF cookbook
- [assistant-ui cookbook](./dev/getting-started/assistant-ui.md) — copy-paste
  provider and tool cards
