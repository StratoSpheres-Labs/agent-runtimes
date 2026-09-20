# Overview

`agent-runtimes` is a Node.js/TypeScript compatibility layer over local AI
coding CLIs (OpenCode, Claude Code, Codex). Every agent speaks a different
dialect — argv shapes, stdin formats, JSONL event kinds, resume flags. This
library hides all of that behind one API:

```
Runtime → Session → Run → RuntimeEvent
```

| Step             | Call                             | You get                                     |
| ---------------- | -------------------------------- | ------------------------------------------- |
| Pick an agent    | `runtimes.resolve("opencode")`   | A `Runtime` — same shape for every CLI      |
| Check it exists  | `runtime.detect()`               | `{ installed, executable, version }`        |
| Open a workspace | `runtime.createSession({ cwd })` | A `Session` spanning many processes         |
| Do one turn      | `session.run(prompt)`            | A `Run` with an async `RuntimeEvent` stream |

## What it is not

- Not an LLM client — it never calls a model API; it spawns the CLIs you installed.
- Not a planner, tool runner, memory, or UI — those belong to the layer above (a daemon or app).
- Not a config manager — it never writes CLI configs or touches credentials. Read-only discovery, spawn-only control.

## Next

- [agent-runtimes 101](./101.md) — why the dialects differ and what gets normalized.
- [Install](./install.md) — build from source.
- [Quickstart](./quickstart.md) — your first run in 5 minutes.
