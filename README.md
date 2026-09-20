# agent-runtimes

[English](./README.md) | [中文](./README.zh-CN.md)

[![CI](https://github.com/StratoSpheres-Labs/agent-runtimes/actions/workflows/ci.yml/badge.svg)](https://github.com/StratoSpheres-Labs/agent-runtimes/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

`agent-runtimes` is a Node.js/TypeScript compatibility layer that unifies discovery, launch, control, and observation of local Agent CLIs through a single `Runtime → Session → Run → RuntimeEvent` API.

> [!WARNING]
> agent-runtimes is currently an early technical preview — Windows is recommended for the best experience. macOS and Linux support is still being optimized, and stability there may lag behind Windows until then.

Developer docs : [Docs](./docs/dev/READDEVDOC.md)

## Supported runtimes

| ID             | Agent            | Session resume                | Live models     | Auth probe                | MCP discovery     |
| -------------- | ---------------- | ----------------------------- | --------------- | ------------------------- | ----------------- |
| `opencode`     | OpenCode CLI     | `-s` (capture-style)          | `models`        | `auth list` + `auth.json` | `mcp list`        |
| `opencode-acp` | OpenCode via ACP | `session/load`                | —               | —                         | via `session/new` |
| `claude`       | Claude Code      | `--resume` (capture-style)    | static aliases¹ | `login status`            | `mcp list`        |
| `codex`        | Codex CLI        | `exec resume` (capture-style) | `debug models`  | `login status`            | `mcp list`        |

¹ Claude Code has no list-models subcommand, so `sonnet` / `opus` / `haiku` (+ full `claude-*-4/5-*` names) are curated statically.

All four also expose read-only discovery — `models()`, `auth()`, `mcp()`, `skills()`, `plugins()` — metadata only, never file contents. Missing data degrades to `"unknown"` / `[]`, never a stale static list.

## Installation

Requires `Node.js >= 20`.

```bash
npm i @stratosphereslab/agent-runtimes
```

Or with pnpm (`pnpm add @stratosphereslab/agent-runtimes`), or from source:

```bash
git clone <this-repo> && cd agent-runtimes
pnpm install && pnpm build
```

## Usage

```ts
import { runtimes } from "@stratosphereslab/agent-runtimes";

const runtime = await runtimes.resolve("opencode"); // or "claude" / "codex"
const status = await runtime.detect(); // { installed, executable, version }
if (!status.installed) throw new Error("agent CLI not found");

const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("Analyze this project and describe its structure");

for await (const event of run.events()) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else if (event.type === "tool_started") console.log(`[tool] ${event.name}`);
  else if (event.type === "done") break;
}
await session.close();
```

Sessions span processes (`Session !== Process`): each `run()` spawns a fresh process, resume continues the agent-native session. Cancel with `run.cancel()` / `session.cancel()` — cleanup is total (stdio, child, listeners, timers).

Session rules worth knowing:

- **One active run per session** — a second `run()` while one is in flight rejects with `RuntimeSessionError` (never silently cancelled). Await the first run's `result()` or `cancel()` it, then call again.
- **Cancel ends with `done`** — `run.cancel()` pushes a terminal `done` carrying the kill signal before closing the stream, so "cancelled" is distinguishable from "stream cut". `close()` alone is silent teardown.
- **Every event carries `runId`** (`<sessionId>:run<N>`, optional on the wire) for grouping interleaved streams; the agent's thinking surfaces as `reasoning_delta`, never mixed into `text_delta`.

## CLI

Check a runtime's health (nonzero exit only when it can't run):

```bash
node dist/cli.js doctor opencode
node dist/cli.js doctor claude
node dist/cli.js doctor codex
```

Sample output:

```
Model             ✓  175 model(s) across 3 providers: deepseek, nvidia, opencode
MCP               ✓  2 server(s): github, firecrawl
```

## Features

- **Discovery** — PATH + aliases + `*_BIN` overrides + known install locations; newest invocable version wins; broken shims skipped. `findAllInstalls()` lists every copy (package manager, version, selected); per-platform recognition keeps foreign shims out.
- **Sessions** — create / run / resume / cancel / close; native ids captured from the stream and persisted (`~/.agent-runtimes/sessions`, relocatable for Electron via `setSessionStoreDir`).
- **History** — read-only conversation history (`session.history()`) folded from each CLI's native transcript store; compact entries, `limit`/`since` paging, fail-open, never persisted by the library.
- **Events** — agent-agnostic `RuntimeEvent` only, JSON-serializable: `session_started | text_delta | reasoning_delta | tool_started | tool_finished | usage | permission_request | error | done`. Never leaks stdout/stderr/JSONL. Every event carries an optional `runId`; thinking is display-only (`reasoning_delta`) and empty thinking is dropped, never errored.
- **Models / Auth / MCP** — per-runtime live discovery (`models()`, `auth()`, `mcp()`); unknown degrades to `"unknown"`, never a stale static list. Explicit models are validated at session creation (`isKnownModel` — typos rejected before anything spawns); opencode `--variant` only sends advertised variants.
- **Skills / Plugins** — read-only metadata discovery (`skills()`, `plugins()`): global + project roots, marketplace ids, versions, enabled state. Never file contents.
- **Versions & diagnostics** — per-adapter CLI version policy (`untested-version` warnings); `doctor` rows carry machine-readable `reason` codes (`not-on-path`, `shim-broken`, `auth-missing`, …) rendered inline. The Version row appends `→ latest` when the npm registry has a newer release (`update-available`).
- **Capabilities, not names** — branch on `runtime.capabilities().sessionResume`, never `runtime.id === "claude"`.
- **Guardrails** — images (path-primary), workspace allowlist / sandbox / permission-mode gating, prompt-size budget, interactive permission requests (`AskUserQuestion` / ACP), secret-free logs and error details.

## Development

```bash
pnpm build      # tsup → dist/
pnpm lint       # eslint (flat + typescript-eslint strict)
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
```

Order matters: `build → lint → typecheck → test` (all four must pass before merge).

- `docs/development.md` / `docs/development.zh-CN.md` — setup, test tiers, adding a runtime, troubleshooting.
- `docs/architecture.md` — the `Runtime ≠ Session ≠ Run ≠ Transport ≠ Parser` model and the seven hard rules.
- `docs/frontend.md` — wire contract for UI consumers: NDJSON framing, `runId` attribution, `reasoning_delta`, cancel semantics.
- `docs/runtime-authoring.md` — how to add `runtimes/<id>/` as an architecture pressure test.
- `AGENTS.md` — repo conventions, layout, testing expectations.

## Project Structure

```
src/core/         # runtime, session, run, registry, lifecycle, session-store — agent-agnostic
src/definition/   # identity, executable, input, transport, session, capability, model, mcp, auth, …
src/events/       # RuntimeEvent, EventStream
src/transport/    # RuntimeTransport + StdioTransport + AcpTransport
src/parser/       # RuntimeParser + JSONL impl (partial-chunk safe)
src/discovery/    # executable / version / models / mcp / auth probing
src/doctor.ts     # doctor report + summarizeModels
src/cli.ts        # agent-runtimes doctor
runtimes/opencode/ | claude/ | codex/ | opencode-acp/  # definition, parser, runtime, session, fixtures
tests/  examples/basic.ts  docs/
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
