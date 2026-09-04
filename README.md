# agent-runtimes

Universal runtime layer for local AI coding agents.

`agent-runtimes` is a Node.js/TypeScript compatibility layer that unifies how you discover, spawn, control, and observe local Agent CLIs (Claude Code, OpenCode, Codex, etc.) through a single `Runtime → Session → Run → RuntimeEvent` API.

> Status: Phase 0 — greenfield. See `Dev_Docs/agent_runtimes_dev_plan.md` for the phased build plan.

## Installation

```bash
pnpm add agent-runtimes
```

Requires `Node.js >= 20`.

## Usage (target API, not yet implemented)

```ts
import { runtimes } from "agent-runtimes";

const runtime = await runtimes.resolve("opencode");
const status = await runtime.detect(); // { installed, executable, version }

const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("Analyze this project and describe its structure");

for await (const event of run.events()) {
  console.log(event); // RuntimeEvent only: text_delta | tool_started | tool_finished | error | done
}
```

Switching agents requires only changing the resolve argument:

```ts
const runtime = await runtimes.resolve("claude"); // same API
```

## CLI

Check a runtime's health (exit code is nonzero only when it can't run):

```bash
npx agent-runtimes doctor opencode
npx agent-runtimes doctor claude
npx agent-runtimes doctor codex
```

## Development

```bash
pnpm build      # tsup → dist/
pnpm lint       # eslint (flat + typescript-eslint strict)
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
```

Order matters: `build → lint → typecheck → test`.

See `AGENTS.md` for architecture rules, layout, and testing expectations.

## Project Structure (v0.1)

```
src/core/         # runtime, session, run, registry, lifecycle — agent-agnostic
src/definition/   # identity, executable, input, transport, session, capability
src/events/       # RuntimeEvent, EventStream
src/transport/    # transport interface + StdioTransport
src/parser/       # parser interface + JSONL impl
src/discovery/    # executable + version detection
runtimes/opencode/ # definition.ts, parser.ts, runtime.ts, fixtures/, index.ts
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
