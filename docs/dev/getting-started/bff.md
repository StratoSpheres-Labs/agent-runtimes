# BFF Cookbook

Connect a frontend (or backend service) to `agent-runtimes` in one thin
slice. This is the **how**; the **contract** lives in
[frontend.md](../../frontend.md) (event shapes, error codes, framing).

```
Agent CLI → Transport → Parser → BFF (Node, holds Session/Run) → SSE → UI (JSON only)
```

## Rule 0: the browser never imports the library

The package spawns child processes (`node:child_process`, `node:fs`) and
runs on Node ≥ 20 — a backend-for-frontend, a daemon, or an Electron
**main** process. The renderer only sees JSON: one `RuntimeEvent` per
line via `encodeRuntimeEvent`, parsed with `decodeRuntimeEventLine`.
`import type` at most.

## Backend: five things

1. **Stream NDJSON as SSE.** `GET /events` runs `session.run(prompt)`
   and writes each event as `data: <encodeRuntimeEvent(event)>`. One
   event per line — the frontend splits on `\n`, never reassembles
   partial JSON.
2. **One active run per session.** A second `run()` while one streams
   rejects with `RuntimeSessionError`. Return 409 ("drain to done
   first") instead of queueing silently. Drain run N to `done` before
   starting run N+1, or resume silently opens a fresh upstream session
   and loses context.
3. **Cancel ends with `done`.** `run.cancel()` / `session.cancel()`
   pushes a terminal `done` carrying the kill signal — "cancelled" is
   distinguishable from "stream cut". `close()` alone is silent
   teardown and emits nothing.
4. **Permissions stay backend-side.** `onPermissionRequest` (a function)
   can never cross the wire (`WireCreateSessionOptions` omits it).
   Forward `permission_request` events downstream for display, answer
   via `run.respondToPermission(id, optionId)`. Denials arrive as
   `permission_denied` — observe-only, nothing to answer.
5. **Switch on `error.code`, never `message`.** Messages are prose and
   may change; the 14-code taxonomy (`TIMEOUT`, `STALL`,
   `NON_ZERO_EXIT`, …) is the machine surface. Unknown `runId`s,
   finished runs, and unsupported `send()` reject loudly — surface the
   error, never retry silently.

## Frontend: four things

1. **Group by `runId`.** Every event carries `<sessionId>:run<N>`;
   reassemble one turn from an interleaved stream by grouping on it.
2. **Render by discriminant.** `text_delta` appends,
   `reasoning_delta` folds (dimmed/collapsed — display-only, never
   resumable input), `tool_started`/`tool_finished` render inline rows,
   `done` closes the turn.
3. **Render blocks, not silence.** `permission_denied` joins with its
   `tool_started`/`tool_finished` by `id` — show "Write blocked: needs
   manual approval" instead of nothing.
4. **Fail open on unknown types.** The event set only grows; ignore
   unknown discriminants with a generic row rather than throwing.

## Beyond SSE

Same events, different framing (`frontend.md` §Framing):

| Transport    | Mapping                                           |
| ------------ | ------------------------------------------------- |
| WebSocket    | one text message per NDJSON line                  |
| Electron IPC | `structuredClone` of the parsed event             |
| Steering up  | `WireSendInput { runId, text }` upstream          |
| Approving    | `WireRespondPermission { id, optionId }` upstream |

`run.send()` needs `allowMidRunInput` on a `midRunInput` runtime (ACP
only) — stdio CLIs reject it; text-only, images stay backend-side.

`optionId` must be one the `permission_request` event offered — never
client-invented.

## Using this from a real chat UI

The four routes above plus the event stream are the whole contract.
`examples/bff-assistant-ui.ts` implements exactly that table
(`pnpm example:bff-ui`) — pick it over `bff-sse.ts` if you use the adapter,
because the adapter POSTs `{ prompt, session }` to `/turn` while `bff-sse.ts`
serves `GET /events?prompt=…` over `EventSource`. If your UI is built on
[assistant-ui](https://www.assistant-ui.com), you do not need to write the
event→message mapping yourself:

```ts
import {
  createRuntimeTransport,
  createThreadStore,
  createExternalStoreAdapter,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

See [assistant-ui.md](./assistant-ui.md) for the cookbook and
[frontend-assistant-ui.md](../../frontend-assistant-ui.md) for the contract.

## Run it

```bash
pnpm example:bff
# open http://localhost:3000 — type a prompt, watch the stream
# RUNTIME_ID=claude pnpm example:bff   # another CLI
```

The demo (`examples/bff-sse.ts`, `node:http` only, zero dependencies)
is the whole slice: demo page, SSE turn endpoint, `/send` steering,
`/cancel`. Copy it, then delete the demo page first — your UI replaces
that part, the rest stays.

Its sibling `examples/bff-assistant-ui.ts` is the same slice for the
[assistant-ui](../assistant-ui.md) adapter: `POST /turn` instead of
`GET /events`, plus `/permission`, and it serves `dist/assistant-ui.js` so the
page can import the bundle directly. `tests/bff-assistant-ui.test.ts` covers its
routes against a stub session, so it is not another hand-run artifact.

## What not to build here

Auth, persistence, multi-user sessions, a shipped HTTP server — those
belong to your app, not this layer. History (`session.history()`) is
read-through and redacted by default; never log it, never forward it
without consent.

## Next

- [Frontend contract](../../frontend.md) — every event type, error codes, queue, versioning.
- [Quickstart](./quickstart.md) — the library-direct flow this slice wraps.
