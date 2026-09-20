# AGENTS.md — agent-runtimes

## 1. Project Positioning

`agent-runtimes` is a Node.js/TypeScript **local Agent Runtime Compatibility Layer** (`src/core` + `runtimes/<agent>/` adapters). It does NOT implement LLM inference, planning, tools, memory, RAG, or UI. It only: discover / spawn / control / communicate / parse / manage sessions for local Agent CLIs (Claude Code, OpenCode, Codex, etc.) and expose a unified `Runtime → Session → Run → RuntimeEvent` API. Reference docs: `Dev_Docs/agent_runtimes_dev_plan.md` (phased build plan), `Dev_Docs/backgrounds_from_chatgpt.md` (why this abstraction exists, Open Design daemon analogy) — both local-only (gitignored); on a fresh clone `docs/` is the source of truth.

## 2. Repo State — v0.1.0, Working

Repo is built: single `agent-runtimes` package, 4 runtimes (`opencode`, `opencode-acp`, `claude`, `codex`), `doctor` CLI, ~443 tests green. Beyond run/streaming: discovery (`installs`, `findAllInstalls`, update checks via `registryId`), read-only `skills`/`plugins`, native `history()` transcripts, `runId` attribution, `reasoning_delta`, cancel-terminal `done`. `Dev_Docs/` (phased build plan, Chinese) exists locally but is **gitignored** — do not rely on it surviving a fresh clone; `docs/` is the committed source of truth. Verify with `Test-Path` / `Get-ChildItem` before editing.

## 3. Stack & Required Commands

Target: `Node.js >= 20`, `TypeScript`, `pnpm`, `tsup` (build), `Vitest` (test), `ESLint` + `Prettier`. After Phase 0, these MUST pass before merge (Task 0.2):

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Order matters: `build` → `lint` → `typecheck` → `test` catches generated-code/type errors early. Plus `pnpm format:check` (Prettier strict) before merge — run `pnpm format` to fix the whole tree.

## 4. Intended Layout (v0.1)

Don't invent a new structure. Follow `Dev_Docs/agent_runtimes_dev_plan.md:382-446`:

```
src/core/         # runtime, session, run, registry, lifecycle — agent-agnostic
src/definition/   # identity, executable, input, transport, session, capability
src/events/       # RuntimeEvent, EventStream
src/transport/    # transport interface + StdioTransport
src/parser/       # parser interface + JSONL impl (must handle partial chunks)
src/discovery/    # executable + version detection
runtimes/opencode/ # definition.ts, parser.ts, runtime.ts, fixtures/, index.ts
tests/core/  tests/integration/
examples/basic.ts  docs/architecture.md
```

Single package for v0.1; do NOT split into `@agent-runtimes/*` yet. New agent = `runtimes/<id>/` with same 5 files (`Dev_Docs/agent_runtimes_dev_plan.md:1885-1911`).

## 5. Core Architecture That Will Surprise You

- `Runtime ≠ Agent ≠ Process ≠ Session ≠ Transport ≠ Parser` (`Dev_Docs/agent_runtimes_dev_plan.md:119-170`). `Session` spans multiple `Process`es (resume creates Process 2); never model `Session` as a thin `ChildProcess` wrapper.
- Data flow is strictly `Agent CLI → Transport (raw bytes) → Parser (→ RuntimeEvent) → App` (`Dev_Docs/agent_runtimes_dev_plan.md:244-260`). Parser owns buffering for split JSON across chunks; Transport must NOT parse agent events.
- Unified `RuntimeEvent` only (`session_started`, `text_delta`, `reasoning_delta`, `tool_started`, `tool_finished`, `usage`, `permission_request`, `error`, `done`). Every event carries optional `runId` (`<sessionId>:run<N>`, stamped by the Run, never the parser). Thinking is display-only; empty thinking drops silently. Never leak `stdout`/`stderr`/`JSONL`/agent-specific JSON to callers.
- Capability > name: check `runtime.capabilities().sessionResume` not `runtime.id === "claude"` (`Dev_Docs/agent_runtimes_dev_plan.md:282-289`).

## 6. Seven Hard Rules — Never Violate

From `Dev_Docs/agent_runtimes_dev_plan.md:1921-1980`:

1. `src/core/**` must NOT contain `if (runtime.id === "xxx")`.
2. Public API must NOT expose CLI flags (`--resume`, `-s`, `--model`, `--variant`, etc.) — hide inside adapter `buildArgs()`.
3. Transport must NOT parse agent-specific events.
4. Parser must NOT manage process/session lifecycle.
5. `Session !== Process`.
6. `RuntimeEvent` must be agent-agnostic.
7. Adding a new runtime should only add an adapter, not modify core — if core needs changing, refactor abstraction first.

## 7. Build Order & Adapter Pressure Test

v0.1 closed at `Phase 11` integration test with real `opencode` CLI, then `claude` (`Phase 12`) and `codex` (`Phase 13`) landed as **architecture pressure tests** — they differ in `buildArgs`, `prompt input (argv/stdin/file)`, `stream format`, `session resume`, `reasoning` mapping. Keep the rule for the next adapter: if adding it forces core edits, core abstraction is wrong.

## 8. Testing Expectations

Four suites required (`Dev_Docs/agent_runtimes_dev_plan.md:1619-1695`):

- **Unit:** registry, definition, arg builder, lifecycle, capabilities.
- **Fixture:** `runtimes/<agent>/fixtures/*.jsonl` → `Parser` → `RuntimeEvent[]` — core of this project. Cover illegal JSON, unknown event, empty input, cross-chunk split, multiple events coalesced (`Dev_Docs/agent_runtimes_dev_plan.md:1049-1062`).
- **Integration:** `resolve → detect → spawn → stdin prompt → stdout parse → done → cleanup` with real CLI installed.
- **Cross-platform:** PATH discovery, spawn, stdin/stdout/stderr, signals, env, file paths on Linux/macOS/Windows — full rules in `docs/cross-platform.md` (no hardcoded paths, `os.tmpdir()` in tests, CI matrix before v1.0.0).

## 9. Lifecycle, Errors & Safety Gotchas

- `cancel()`/`timeout`/`close()` must fully clean: `stdin`, `stdout`, `stderr`, child process, listeners, timers, buffers, promises — zero zombies/leaks/hanging promises (`Dev_Docs/agent_runtimes_dev_plan.md:744-791,1849-1879`).
- Error hierarchy (`Dev_Docs/agent_runtimes_dev_plan.md:1701-1722`): `RuntimeError` → `RuntimeNotFoundError`, `RuntimeVersionError`, `RuntimeSpawnError`, `RuntimeTimeoutError`, `RuntimeProtocolError`, `RuntimeSessionError`; always attach `cause` and include `{ runtime, command, cwd, exitCode, signal }` but never secrets.
- Do NOT blindly forward `process.env` to child — may leak `API_KEY`/`TOKEN` (`Dev_Docs/agent_runtimes_dev_plan.md:1827-1845`). Future `cwd`/`workspace`/`allowedPaths`/`permissionMode` constraints belong in `Session` options.
- Logging: no `console.log` in runtime; inject `RuntimeLogger { debug, info, warn, error }`, default silent (`Dev_Docs/agent_runtimes_dev_plan.md:1755-1795`).
- Version/capability detection via `command --version` + `command --help` flag probing before using a flag (e.g. `--add-dir`) — old CLIs crash on unknown flags (`Dev_Docs/backgrounds_from_chatgpt.md:539-574`).

## 10. Decided Conventions (2026-09-03)

- Package: single `agent-runtimes` for v0.1 (no `@agent-runtimes/*` split yet — `Dev_Docs/agent_runtimes_dev_plan.md:448`).
- Docs: README/docs English-primary, code comments English; keep `Dev_Docs/` Chinese as historical reference.
- License: `Apache-2.0` (not MIT) — add `LICENSE` in Phase 0 Task 0.1.
- Git: `main` NOT protected until first release; direct commits to `main` allowed before v1.0.0. Commits still follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, etc.). Switch to protected + `feat/*` → PR after release.
- Lint: `ESLint` flat config + `typescript-eslint` strict + `Prettier` strict (fail on warning before merge).
- Local CLIs verified on this machine: `opencode 1.18.31`, `claude 2.1.276`, `codex 0.150.1`. Use `opencode run --format json --thinking --model <provider/model> --session <id>` for adapter/integration tests (`--thinking` is passed by default so `reasoning` parts stream).

## 11. How to Work in This Repo (for OpenCode)

- Read `docs/architecture.md` + `docs/development.md` before coding (`Dev_Docs/` plan is local-only history). MCP/ACP/Auth/Image/Workspace/Permission/Skills/Plugins all landed — don't re-defer them; don't jump to the next unscoped thing either.
- Prefer executable source of truth: `package.json` scripts, `tsconfig.json`, `vitest.config.ts` over prose when they conflict.
- Keep changes minimal and reversible; direct commits to `main` allowed before v1.0.0.

## 12. Reference — Ideal Developer Experience (implemented)

```ts
import { runtimes } from "agent-runtimes";
const runtime = await runtimes.resolve("opencode"); // or "claude" / "codex" — same API
const status = await runtime.detect(); // { installed, executable, version }
const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("分析这个项目，并告诉我整体结构");
for await (const event of run.events()) {
  console.log(event);
} // RuntimeEvent only
```
