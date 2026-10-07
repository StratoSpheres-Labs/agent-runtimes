# AGENTS.md — agent-runtimes

## 1. Project Positioning

`agent-runtimes` is a Node.js/TypeScript **local Agent Runtime Compatibility Layer** (`src/core` + `runtimes/<agent>/` adapters). It does NOT implement LLM inference, planning, tools, memory, RAG, or UI. It only: discover / spawn / control / communicate / parse / manage sessions for local Agent CLIs (Claude Code, OpenCode, Codex, etc.) and expose a unified `Runtime → Session → Run → RuntimeEvent` API. Source of truth: `docs/` (committed). History: `Dev_Docs/` (phased build plan, Chinese) is local-only and gitignored — never cite it in committed docs; on a fresh clone it does not exist.

## 2. Repo State — v0.1.3, Working

Single `agent-runtimes` package on npm (`@stratosphereslab/agent-runtimes@0.1.3`, tag-driven publish), 4 runtimes (`opencode`, `opencode-acp`, `claude`, `codex`), `doctor` CLI, 728 tests green (Oct 2026). Beyond run/streaming: discovery (`installs`, `findAllInstalls`, update checks via `registryId`), read-only `skills`/`plugins`, native `history()` transcripts (redacted by default), `runId` attribution, `reasoning_delta`, cancel-terminal `done`, run journal (NDJSON), run queue (tap-only, drain-driven), idle reaper + `shutdownAllSessions`, stall watchdog (`STALL`), and a shipped **assistant-ui adapter** on its own browser-safe subpath (`@stratosphereslab/agent-runtimes/assistant-ui`). Capability inventory: `docs/PARITY.md` (shipped vs deferred — check it before promising anything).

## 3. Stack & Required Commands

Target: `Node.js >= 20`, `TypeScript`, `pnpm`, `tsup` (build), `Vitest` (test), `ESLint` + `Prettier`. ESM-only, zero runtime dependencies. These MUST pass before merge:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Order matters: `build` → `lint` → `typecheck` → `test` catches generated-code/type errors early. Plus `pnpm format:check` (Prettier strict, run `pnpm format` to fix) and `pnpm audit --audit-level moderate` (advisories fail CI; low is informational). CI mirrors all of it: static gates once (ubuntu/node24) + test matrix (windows/macos/ubuntu × node22/24, one retry for fleet preemption) + real-CLI leg (opencode on ubuntu/node24).

## 4. Actual Layout

```
src/core/         # runtime, session, run, registry, lifecycle, session-store, run-journal, idle-reaper — agent-agnostic
src/definition/   # identity, executable, input, transport, session, capability, model, auth, mcp, permission, workspace, …
src/events/       # RuntimeEvent, EventStream
src/transport/    # RuntimeTransport + StdioTransport + AcpTransport
src/parser/       # RuntimeParser + JSONL impl (partial-chunk safe)
src/frontend/assistant-ui/ # browser-safe chat-UI adapter — own subpath export, zero node deps
src/discovery/    # executable / version / installs / models / auth / mcp / updates / toolchain
src/doctor.ts     # doctor report + reason codes + formatReport
src/cli.ts        # agent-runtimes [-d|--doctor] [<id>] [--json] (doctor, help family, --version)
src/wire.ts       # frontend wire contract (WireCreateSessionOptions, WireSendInput, WireRespondPermission, NDJSON framing)
runtimes/<id>/    # definition, parser, runtime, session, transcript (+ fixtures/, compat records)
tests/            # flat, 60+ files (unit + fixture + integration)
examples/basic.ts  examples/bff-sse.ts  docs/
```

Single package (no `@agent-runtimes/*` split). New agent = new `runtimes/<id>/` adapter only — if it forces core edits, the abstraction is wrong (Rule 7).

`src/frontend/assistant-ui/` ships as `@stratosphereslab/agent-runtimes/assistant-ui` on its **own tsup entry** (`platform: "browser"`, `target: "es2022"`). It must never be re-exported from `src/index.ts`: the root entry pulls in `node:child_process`, and a renderer importing it would fail to bundle. `tests/assistant-ui-browser-safe.test.ts` walks the transitive runtime import graph and fails on any `node:` builtin, any bare dependency, or any reach into `src/core/` beyond `errors.ts`.

## 5. Core Architecture That Will Surprise You

- `Runtime ≠ Agent ≠ Process ≠ Session ≠ Transport ≠ Parser` (`docs/architecture.md`). `Session` spans multiple `Process`es (resume creates Process 2); never model `Session` as a thin `ChildProcess` wrapper.
- Data flow is strictly `Agent CLI → Transport (raw bytes) → Parser (→ RuntimeEvent) → App`. Parser owns buffering for split JSON across chunks; Transport must NOT parse agent events.
- Unified `RuntimeEvent` only (10 types: `session_started`, `text_delta`, `reasoning_delta`, `tool_started`, `tool_finished`, `usage`, `permission_request`, `permission_denied`, `error`, `done`). Every event carries optional `runId` (`<sessionId>:run<N>`, stamped by the Run, never the parser). Thinking is display-only; empty thinking drops silently. Never leak `stdout`/`stderr`/`JSONL`/agent-specific JSON to callers.
- Capability > name: check `runtime.capabilities().sessionResume`, never `runtime.id === "claude"`.

## 6. Seven Hard Rules — Never Violate

1. `src/core/**` must NOT contain `if (runtime.id === "xxx")`.
2. Public API must NOT expose CLI flags (`--resume`, `-s`, `--model`, `--variant`, etc.) — hide inside adapter `buildArgs()`.
3. Transport must NOT parse agent-specific events.
4. Parser must NOT manage process/session lifecycle.
5. `Session !== Process`.
6. `RuntimeEvent` must be agent-agnostic.
7. Adding a new runtime should only add an adapter, not modify core — if core needs changing, refactor abstraction first.

## 7. Build Order & Adapter Pressure Test

`opencode` landed first, then `claude` and `codex` as **architecture pressure tests** — they differ in `buildArgs`, `prompt input (argv/stdin/file)`, `stream format`, `session resume`, `reasoning` mapping. Keep the rule for the next adapter: if adding it forces core edits, core abstraction is wrong. `opencode-acp` covers the ACP transport shape (mid-run `send()`, interactive permissions).

## 8. Testing Expectations

- **Unit:** registry, definition, arg builder, lifecycle, capabilities.
- **Fixture:** `runtimes/<agent>/fixtures/*.jsonl` → `Parser` → `RuntimeEvent[]` — core of this project. Cover illegal JSON, unknown event, empty input, cross-chunk split, multiple events coalesced.
- **Integration:** `resolve → detect → spawn → stdin prompt → stdout parse → done → cleanup` with real CLI installed (graceful skip when absent; live legs on CI + local).
- **Cross-platform:** PATH discovery, spawn, stdin/stdout/stderr, signals, env, file paths on Linux/macOS/Windows — full rules in `docs/cross-platform.md` (no hardcoded paths, `os.tmpdir()` in tests).
- **Hermetic default:** stub registries / stub HTTP servers / injected seams; live-network tests follow the early-return-offline pattern, never hard-fail offline.

## 9. Lifecycle, Errors & Safety Gotchas

- `cancel()`/`timeout`/`close()` must fully clean: `stdin`, `stdout`, `stderr`, child process, listeners, timers, buffers, promises — zero zombies/leaks/hanging promises. `cancel()` ends with terminal `done`; `close()` alone is silent teardown.
- One active run per session: a second `run()` while one is in flight rejects with `RuntimeSessionError` (or waits with `queue: true`, FIFO on observed `done`). Drain run N to `done` before run N+1 or resume silently loses context.
- Error hierarchy: `RuntimeError` → `RuntimeNotFoundError`, `RuntimeVersionError`, `RuntimeSpawnError`, `RuntimeTimeoutError`, `RuntimeProtocolError`, `RuntimeSessionError`; always attach `cause` and include `{ runtime, command, cwd, exitCode, signal }` but never secrets. Wire codes (`TIMEOUT`, `STALL`, `NON_ZERO_EXIT`, …): switch on `code`, never on `message`.
- Do NOT blindly forward `process.env` to child — may leak `API_KEY`/`TOKEN`. Workspace constraints (`allowedPaths`, `sandboxMode`, `permissionMode`, …) belong in `Session` options, rejected loudly when a runtime has no channel.
- Logging: no `console.log` in runtime; inject `RuntimeLogger { debug, info, warn, error }`, default silent.
- Version/capability detection via `command --version` + `command --help` flag probing before using a flag — old CLIs crash on unknown flags. Record results with `pnpm compat:record`; fail-open rows reappear on newer CLIs until re-recorded.
- Transcripts are redacted by default (`redacted: true`); pass `includeRawInputs` only for trusted first-party use.
- The browser boundary is enforced, not just documented: `src/frontend/assistant-ui/` must stay free of `node:` specifiers and bare dependencies (it borrows only `src/wire.ts` and `src/core/errors.ts`), it never adds a `RuntimeEvent`, and it never re-exports from `src/index.ts`. It ships **local structural types** mirroring assistant-ui's shapes instead of importing them, so the bundle has zero runtime deps; `tests/assistant-ui-conformance.test.ts` assigns what we emit to the real `@assistant-ui/core` types (a devDependency) so upstream drift fails `pnpm typecheck` rather than a consumer's build. It is also a **separate tsconfig project** (`tsconfig.frontend.json`, the only place `"DOM"` is allowed) so `document` cannot appear in Node code.
- **A capability the adapter does not wire is a capability it does not have.** `onEdit`/`onReload`/`onResume` are absent from the assistant-ui adapter on purpose: every CLI resume path only extends a session, so "edit and re-ask" would leave the agent holding the old transcript while the UI looked correct. Never document a UI affordance the exported adapter does not actually provide.

## 10. Decided Conventions

- Package: single `agent-runtimes`, ESM-only, Node ≥ 20.
- Docs: README/docs English-primary with `*.zh-CN.md` mirrors; code comments English. `docs/dev/` holds the getting-started track (`READDEVDOC.md`, `overview/101/install/quickstart/bff/assistant-ui/modes`, `llms.txt` for AI consumers); deep dives live in `docs/` (`architecture`, `development`, `frontend` wire contract, `frontend-assistant-ui`, `runtime-authoring`, `cross-platform`, `PARITY`).
- License: `Apache-2.0` — see `LICENSE`.
- Git: `main` NOT protected until first release; direct commits to `main` allowed before v1.0.0. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, …). One commit per batch of work; **push only on explicit approval, tags separately** (a tag push fires npm publish). Switch to protected + `feat/*` → PR after v1.0.0.
- Lint: `ESLint` flat config + `typescript-eslint` strict + `Prettier` strict (fail on warning before merge).
- CLI discipline: help is liberal (`-h/--help/-help/help`, exit 0), everything else stays strict (unknown → exit 2). Exit codes: `0` healthy, `1` run-blocking failure, `2` usage error — hints and colors never change them. `--json` output stays machine-pure (no hints, no ANSI); human nudges (`↻ update:`) ride stderr and never auto-install. Never hardcode the package version — read `package.json` (`createRequire` survives bundling).
- Release flow (tags-only): bump `package.json` → commit → push `main` → `git tag vX.Y.Z && git push origin vX.Y.Z` (separate approval). Tag must equal `package.json` version or publish refuses. `release.yml` builds the GitHub Release page; `publish.yml` (npm provenance) is never edited casually.
- No unified cross-agent `mode` enum and no agent-preset catalog: permission modes (`WorkspaceOptions`) and agent names (`agent` pass-through) stay per-runtime and orthogonal — see `docs/dev/getting-started/modes.md`. Agent definitions come from workspace config (untrusted input, transmitted never vouched for).
- Library stays read-only toward the machine: no `init`, no self-update executor, no config writes, no postinstall side effects. Give copy-paste lines, don't execute them.
- Local CLIs last verified: `opencode 2.x`, `claude 2.1.x`, `codex 0.159.x` (registry moves faster than this file — `doctor` is the live truth, re-record compat on upgrade).

## 11. How to Work in This Repo

- Read `docs/architecture.md` + `docs/development.md` before coding; `docs/dev/READDEVDOC.md` maps the rest (getting-started track → deep dives → `llms.txt`).
- Prefer executable source of truth: `package.json` scripts, `tsconfig.json`, `vitest.config.ts`, `src/` + `tests/` over prose when they conflict — then fix the prose.
- Keep changes minimal and reversible; verify through execution (run code, run tests) before claiming done. If evidence contradicts a previous claim, say so and trust the evidence.
- Doctor is the first diagnostic: `agent-runtimes -d [<id>] [--json]` before guessing about a runtime's health.

## 12. Reference — Ideal Developer Experience (implemented)

```ts
import { runtimes } from "@stratosphereslab/agent-runtimes";
const runtime = await runtimes.resolve("opencode"); // or "claude" / "codex" — same API
const status = await runtime.detect(); // { installed, executable, version }
const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("分析这个项目，并告诉我整体结构");
for await (const event of run.events()) {
  console.log(event);
} // RuntimeEvent only
```
