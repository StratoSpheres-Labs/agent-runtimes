# Quickstart

Five minutes, one agent turn. Assumes [Install](./install.md) is done and
at least one CLI is on PATH.

## 1. Detect

```ts
import { runtimes } from "@stratosphereslab/agent-runtimes";

const runtime = await runtimes.resolve("opencode"); // or "claude" / "codex"
const status = await runtime.detect();
if (!status.installed) throw new Error("agent CLI not found");
console.log(status.executable, status.version);
```

## 2. Run

```ts
const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("Reply with exactly: pinecone");

for await (const event of run.events()) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else if (event.type === "tool_started") console.log(`[tool] ${event.name}`);
  else if (event.type === "done") break;
}
await session.close();
```

Typical output — three events, each stamped with the run id:

```json
{"type":"session_started","sessionId":"ses_f47…","runId":"sess_mu8…:run1"}
{"type":"text_delta","text":"pinecone","runId":"sess_mu8…:run1"}
{"type":"done","exitCode":0,"runId":"sess_mu8…:run1"}
```

## 3. Rules you just relied on

- One active run per session — a second `run()` while one is in flight
  rejects instead of silently cancelling the first.
- `run.cancel()` ends the stream with a terminal `done`; `close()` alone
  is silent teardown.
- Thinking arrives as `reasoning_delta`, never mixed into `text_delta`.

## If it fails

- `RuntimeNotFoundError` — wrong id in `resolve()`; valid ids:
  `opencode`, `opencode-acp`, `claude`, `codex`.
- Process exits non-zero — you get an `error` event, then `done`. The
  message carries the cause, never secrets.
- Full error catalog: [Resources](../resources/errors.md).

## Next

- [Core model](../concepts/core-model.md) — what Runtime/Session/Run actually are.
- [Streaming](../running/runs-streaming.md) — every event type, permissions, usage.
