# assistant-ui Cookbook

Copy-paste wiring for a React chat UI on top of `agent-runtimes`. The contract
lives in [frontend.md](../../frontend.md); the adapter's design and full event
mapping live in [frontend-assistant-ui.md](../../frontend-assistant-ui.md).

This is the **how**. Read it after the BFF slice
([bff.md](./bff.md)) — a UI needs a backend that streams `RuntimeEvent`.

## Install

```bash
pnpm add @stratosphereslab/agent-runtimes @assistant-ui/react
npx assistant-ui@latest add thread     # Thread + Composer components
```

**Want to see the whole slice run first?** In a clone of this repo:

```bash
pnpm build            # produces dist/assistant-ui.js
pnpm example:bff-ui   # http://localhost:3000
```

That demo (`examples/bff-assistant-ui.ts`) is the backend these snippets talk
to: the four routes the transport calls, plus a page that imports the bundle
straight out of `dist/`. Read it before writing your own — it is short, and its
routes are covered by `tests/bff-assistant-ui.test.ts`, so it is not a
hand-run artifact that can quietly rot.

The adapter ships on its own subpath, so nothing from the Node side of the
package reaches your bundle:

```ts
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

> Never import `@stratosphereslab/agent-runtimes` (the root) in a component —
> it re-exports the Node-only API and your bundler will choke on `node:child_process`.

## 1. The provider

```tsx
"use client";
import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";

export function AgentProvider({
  children,
  sessionId = "default",
}: {
  children: ReactNode;
  sessionId?: string;
}) {
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
          sessionId,
        }),
      }),
    [sessionId],
  );

  const runtime = useExternalStoreRuntime(createExternalStoreAdapter(store));
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

Everything below the provider now works: streaming text, thinking, tool cards,
cancel (a real server interrupt), usage/cost, and the approval gate.

**What you do not get:** Edit, Regenerate and branching. Those buttons are
absent on purpose — every resume path in every supported CLI only _extends_ a
session, so "edit and re-ask" would silently leave the agent holding the old
transcript. See
[frontend-assistant-ui.md](../../frontend-assistant-ui.md#not-supported-edit-regenerate-branching).
If you need a real rewind, start a new `Session`.

## 2. The page

```tsx
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentProvider } from "./AgentProvider";

export default function Page() {
  return (
    <AgentProvider>
      <Thread />
    </AgentProvider>
  );
}
```

## 3. Tool cards

`tool_started` / `tool_finished` arrive as assistant-ui `tool-call` parts, so
the stock rendering already works. To style them, write a component that reads
the current part from assistant-ui state — here for a `bash` call:

```tsx
import { useAuiState } from "@assistant-ui/react";

export function BashToolUI() {
  const call = useAuiState((s) => s.part);
  if (call.type !== "tool-call") return null;

  const command = typeof call.args.command === "string" ? call.args.command : "";
  return (
    <div className="rounded border px-2 py-1 text-xs">
      <div className="font-mono">
        {call.status.type === "running" ? "…" : ""} $ {command}
      </div>
      {call.result !== undefined && (
        <pre className="mt-1 max-h-40 overflow-auto text-xs opacity-70">{String(call.result)}</pre>
      )}
      {call.isError === true && <div className="text-red-600">failed</div>}
    </div>
  );
}
```

Mount it inside `MessagePrimitive.Parts`' children render function, matching on
`part.type === "tool-call"` and `part.toolName === "bash"`. The
[Tool Rendering guide](https://www.assistant-ui.com/docs/api-reference/tools/rendering)
lists the registration forms (a toolkit entry's `render` field, or
`makeAssistantToolUI`) — pick whichever your installed version exports, since
that helper has been renamed across releases.

Two things worth knowing from the fold:

- `args` is always an object. A non-object `tool_started.input` is wrapped
  under `value`, with the raw JSON still in `argsText`.
- `call.approval` exists only while the gate is open (see next section).

## 4. The approval gate (Allow / Deny)

`permission_request` sets `approval: { id, prompt, options }` on the tool part
and flips the message status to `requires-action`. assistant-ui's `ToolFallback`
already renders Allow / Deny in that state, so the zero-code path is:

```tsx
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";

export function ApprovalUI() {
  const status = useAuiState((s) => s.part.status);
  return status.type === "requires-action" ? <ToolFallback /> : null;
}
```

**Check this before building any of it: the gate only exists on `claude` today.**
It is the only runtime that emits `permission_request` at all, and the only one
whose `PermissionRequest` carries an `id` the backend can correlate an answer
with. `opencode-acp` has neither, so a UI approval round trip there always
404s — answer inside `onPermissionRequest` instead. The full table is in
[frontend-assistant-ui.md](../../frontend-assistant-ui.md#the-id-a-ui-answer-must-carry-and-where-it-breaks).

If you want the agent's own wording and choices, answer through the store —
that path is pinned by this package's tests, unlike toolkit helper names:

```tsx
import { useAuiState } from "@assistant-ui/react";
// `store` is the one you built in step 1 — lift it into a context.

export function GateUI() {
  const part = useAuiState((s) => s.part);
  if (part.type !== "tool-call" || part.approval === undefined) return null;
  const { id, prompt, options } = part.approval;

  return (
    <div className="rounded border border-amber-400 p-2 text-xs">
      <p className="font-medium">{prompt ?? "The agent asks permission"}</p>
      <div className="mt-2 flex gap-2">
        {(options ?? [{ id: "allow", kind: "allow-once", label: "Allow" }]).map((o) => {
          const approved = !/reject|deny/i.test(o.kind);
          return (
            <button
              key={o.id}
              onClick={() => {
                // Rejects (and re-opens the gate) if the answer cannot be
                // delivered, so the card never sits on "allowed" while the
                // agent is still parked.
                void store
                  .respondToApproval({ approvalId: id, approved, optionId: o.id })
                  .catch((err: unknown) => console.error("approval failed", err));
              }}
            >
              {o.label ?? o.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

The same thing outside React:

```ts
import { createThreadStore } from "@stratosphereslab/agent-runtimes/assistant-ui";

const store = createThreadStore({ transport });
await store.respondToApproval({ approvalId: "p1", approved: true, optionId: "allow-once" });
```

`optionId` must be one the event offered — it becomes
`WireRespondPermission { id, optionId }` on the wire, and an invented one is
silently meaningless.

The card flips immediately; a rejected POST leaves the gate answered locally
`permission_denied` is **not** a gate — the harness already decided. It shows up
as `approval.approved === false` plus an `isError` result, so render "blocked"
inline rather than offering buttons.

## 5. Reasoning

`reasoning_delta` becomes a `reasoning` part. assistant-ui renders it as nothing
by default, so opt in with the `Reasoning` element inside the parts children
render function:

```tsx
import { MessagePrimitive } from "@assistant-ui/react";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";

<MessagePrimitive.Parts>
  {({ part }) => (part.type === "reasoning" ? <Reasoning /> : part.toolUI)}
</MessagePrimitive.Parts>;
```

Or fold it into a ChainOfThought accordion with `groupBy` — `reasoning` and
`tool-call` both group under it, which is exactly the shape an agent turn has.

## 6. Cost and tokens

`usage` lands on `metadata.steps[].usage` and `metadata.custom`:

```tsx
function UsageBadge() {
  const meta = useAuiState((s) => s.message.metadata);
  const step = meta?.steps?.[0];
  if (step?.usage === undefined) return null;
  return (
    <span className="text-[10px] opacity-60">
      {step.usage.inputTokens} in / {step.usage.outputTokens} out
    </span>
  );
}
```

`usage.costUsd` is also folded — expose it yourself (assistant-ui has no stock
cost meter bound to this shape).

## 7. Structured cards via `data-*`

Anything the agent produces that is not text rides the `data-*` channel:

```ts
store.emit({ type: "data-spec-sheet", data: { title: "Q3 revenue", rows } });
```

```tsx
import { useAuiState } from "@assistant-ui/react";

export function SpecSheet({ data }: { data: { title: string; rows: number } }) {
  return (
    <div className="rounded border p-2 text-xs">
      <div className="font-medium">{data.title}</div>
      <div>{data.rows} rows</div>
    </div>
  );
}

// Inside MessagePrimitive.Parts, match the emitted part and render it:
//
//   {({ part }) =>
//     part.type === "data-spec-sheet" ? <SpecSheet data={part.data} /> : null
//   }
```

Note the two spellings: `{ type: "data-spec-sheet", data }` is the
external-store form, `{ type: "data", name: "spec-sheet", data }` the
local-runtime one. `emit` takes either and `createChatModelAdapter` translates
on the way out.

## 8. Model picker and reasoning effort

Nothing in this package wires these — the lists are yours to own, sourced from
`runtime.models()` and `runtime.capabilities().reasoning` behind your own route:

```tsx
import { useState } from "react";

export function ModelRail() {
  // Fetched from your backend, e.g. GET /api/agent/models -> runtime.models().
  const [model, setModel] = useState("sonnet");
  return (
    <select value={model} onChange={(e) => setModel(e.target.value)}>
      <option value="sonnet">sonnet</option>
      <option value="opus">opus</option>
    </select>
  );
}
```

Then pass it into `createSession({ model })` / `run(prompt, { model })` on the
backend — the browser never sees the CLI flags.

`models()` and `capabilities()` are read-only discovery on the Node side; expose
them through your own route and pass the values into the session.

## 9. Errors

```tsx
import { ErrorPrimitive } from "@assistant-ui/react";

<ErrorPrimitive.Root>
  {/* Renders the message status error. The machine-readable code is on
      message.metadata.custom.errorCode — switch on that, never on prose. */}
  <ErrorPrimitive.Message />
</ErrorPrimitive.Root>;
```

```ts
const code = msg.metadata?.custom?.["errorCode"] as string | undefined;
switch (code) {
  case "STALL":
  case "TIMEOUT":
    return showRetry(); // the turn is dead; offer a retry
  case "NON_ZERO_EXIT":
    return showAgentCrashed();
  case "PERMISSION_ANSWER_FAILED":
    return showStillWaiting(); // the agent is still parked — retry or cancel
  default:
    return showGeneric();
}
```

A turn cut before `done` (network drop, unmount) settles as
`incomplete` / `cancelled` rather than leaving the message on `running`.

## 10. Steering mid-run (ACP runtimes only)

```ts
const transport = createRuntimeTransport({ endpoints: { turn, send } });
await transport.send(runId, "actually use pnpm, not npm");
```

Only ACP runtimes support it; stdio CLIs reject it and the backend answers
`400`. Wire the composer queue to it (`unstable_enableMessageQueue` /
`createMessageQueue`) so a message typed mid-run steers instead of erroring.

## Gotchas

- **One active run per session.** A second turn while one streams rejects
  (`RuntimeSessionError` locally, `409` from the backend). Drain to `done`
  first — otherwise resume silently opens a _fresh_ upstream session and loses
  context.
- **Drain before you resume.** The native session id is captured from run N's
  stream, so an undrained run N+1 opens a new upstream session.
- **Yield snapshots, not deltas.** If you write your own adapter on top of
  `createAssistantTurn`, yield `snapshot()` whole.
- **Never emit an empty text part.** It marks the previous part complete and
  truncates a streamed answer. `emit()` throws rather than let you.
- **`reasoning_delta` is display-only.** It is never resumable input.
- **Don't log `session.history()`.** It is redacted by default, but it can still
  contain user-pasted secrets; never forward it without explicit consent.

## Next

- [frontend-assistant-ui.md](../../frontend-assistant-ui.md) — the adapter's
  design, full mapping table, and what it deliberately does not cover
- [frontend.md](../../frontend.md) — wire contract and error-code taxonomy
- [bff.md](./bff.md) — the BFF cookbook this UI sits on top of
