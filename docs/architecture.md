# Architecture

## Positioning

`agent-runtimes` is a **local Agent Runtime Compatibility Layer** — not an LLM SDK, agent framework, or UI. It unifies how you discover, spawn, control, and observe CLIs like Claude Code / OpenCode / Codex through one API.

Reference: `Dev_Docs/agent_runtimes_dev_plan.md` (phased plan), `Dev_Docs/backgrounds_from_chatgpt.md` (Open Design daemon analogy).

## Core Distinctions

- `Runtime ≠ Agent ≠ Process ≠ Session ≠ Transport ≠ Parser` (`Dev_Docs:119-170`).
  - `Session` spans multiple `Process`es (resume creates Process 2). Never model `Session` as `ChildProcess`.
  - `Runtime` owns discovery & session creation; `Session` owns multi-`Run` lifecycle; `Run` owns one `Transport→Parser→RuntimeEvent` pipeline.

## Who Creates Whom

```
Runtime  —— 找到 CLI，创建 Session（detect / createSession）
  └─ Session —— 横跨多次进程，记住 agent 原生会话 id，创建 Run
       └─ Run —— 一次进程：搬字节 → 翻事件 → 结束即 done
```

`Session !== Process`：续接（resume）就是开第 2 个进程、带上老会话 id；Session 本人从不等于某个子进程。

## Data Flow (inside one Run)

以 `session.run("你好")` 跑 codex 为例：

```
session.run("你好")
  │ ① Session 拼好 argv（buildArgs 把 --json/--sandbox/-C 藏好），创建 Run
  ▼
Transport —— 只管搬字节，不认识 JSON（Rule 3）
  │ spawn("codex", ["exec", "--json", …])，stdout 流出原始字节，
  │ 而且可能半包：
  │   chunk1: {"type":"thread.started","thread_id":"thr_
  │   chunk2: abc"}\n{"type":"item.completed",…
  ▼
Parser —— 只管翻译，不认识进程（Rule 4）
  │ 把字节攒成整行 JSON，再翻成统一事件：
  │   { type: "session_started", sessionId: "thr_abc" }
  │   { type: "text_delta", text: "…" }
  ▼
你的代码 —— 只看到 RuntimeEvent，看不到字节/JSONL/进程（Rule 6）
  for await (const e of run.events()) …
```

分工的意义：输出乱了找 Parser（半包、拼行、非法 JSON、未知类型都是它扛），进程僵死了找 Transport/Lifecycle，两边互不背锅。

## Public API

```ts
import {
  RuntimeRegistry,
  opencodeDefinition,
  OpencodeRuntime,
} from "@stratosphereslab/agent-runtimes";
const registry = new RuntimeRegistry();
registry.register(opencodeDefinition);
const runtime = await registry.resolve("opencode"); // or new OpencodeRuntime()
await runtime.detect(); // { installed, executable, version }
const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("Analyze this project");
for await (const e of run.events()) {
  /* RuntimeEvent only */
}
```

Unified `RuntimeEvent` only: `session_started | text_delta | tool_started | tool_finished | error | done` (`src/events/runtime-event.ts:1`). No `stdout/stderr/JSONL` leaks.

## Capability > Name

Check `runtime.capabilities().sessionResume`, not `runtime.id === "claude"` (`Dev_Docs:282-289`).

## Directory Layout (v0.1)

```
src/core/         # runtime, session, run, registry, lifecycle — agent-agnostic
src/definition/   # identity, executable, input, transport, session, capability
src/events/       # RuntimeEvent, EventStream
src/transport/    # transport interface + StdioTransport + AcpTransport
src/parser/       # parser interface + JSONL impl
src/discovery/    # executable + version detection
runtimes/opencode/ # definition.ts, parser.ts, runtime.ts, fixtures/, index.ts
tests/  tests/integration/  examples/basic.ts
```

Single package for v0.1; `@agent-runtimes/*` split deferred (`Dev_Docs:448`).

## Lifecycle & Safety

- `cancel()/timeout/close()` must fully clean `stdin/stdout/stderr/child/listeners/timers/buffers/promises` — zero zombies (`Dev_Docs:744-791,1849-1879`).
- Errors: `RuntimeError` hierarchy with `cause` + `{runtime, command, cwd, exitCode, signal}` but never secrets (`Dev_Docs:1701-1722`).
- Never forward `process.env` blindly (may leak `API_KEY`/`TOKEN`) (`Dev_Docs:1827-1845`).
- Logging: inject `RuntimeLogger {debug,info,warn,error}`, default silent (`Dev_Docs:1755-1795`).
- Capability detection via `command --version` + `command --help` flag probing — old CLIs crash on unknown flags (`backgrounds_from_chatgpt.md:539-574`).

## Seven Rules (Dev_Docs:1921-1980)

1. `src/core/**` must not contain `if (runtime.id === "xxx")`
2. Public API must not expose CLI flags (`--resume`, `-s`, etc.) — hide in `buildArgs()`
3. Transport must not parse agent events
4. Parser must not manage process/session lifecycle
5. `Session !== Process`
6. `RuntimeEvent` must be agent-agnostic
7. Adding a runtime adds only an adapter; if core needs changing, refactor abstraction first

## Testing

- **Unit**: registry/definition/arg builder/lifecycle/capabilities
- **Fixture**: `runtimes/<agent>/fixtures/*.jsonl` → `Parser` → `RuntimeEvent[]` (illegal/unknown/empty/partial/coalesced)
- **Integration**: `resolve → detect → spawn → stdout parse → done → cleanup` with real CLI
- **Cross-platform**: PATH/spawn/stdio/signals/env/file paths on Linux/macOS/Windows — see `docs/cross-platform.md`
