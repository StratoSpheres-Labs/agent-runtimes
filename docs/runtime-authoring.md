# Runtime Authoring Guide

Add a new agent without modifying `src/core` (Rule 7). If core needs changing, refactor abstraction first.

## Required Layout

```
runtimes/<id>/
  definition.ts   # RuntimeDefinition + buildArgs()
  parser.ts       # RuntimeParser → RuntimeEvent
  runtime.ts      # adapter class (extends DefaultRuntime if CLI-based)
  fixtures/       # *.jsonl samples → parser tests
  index.ts        # re-exports
```

See `Dev_Docs:1885-1911` and `runtimes/opencode/` as reference.

## Step-by-Step

1. **Definition** (`definition.ts`): fill `RuntimeDefinition` — `identity {id,name}`, `executable {command, versionArgs}`, `input {type:"stdin"|"argv"|"file"}`, `transport {type:"stdio"|"acp"}`, `capabilities {streaming, sessionResume, modelSelection, reasoning, images, workspace}`, `session {persistent}`.

2. **buildArgs()**: implement `buildArgs(options): string[]` that hides all CLI flags (`--resume`, `-s`, `--model`, `--variant`, etc.) — Rule 2. Example (`runtimes/opencode/definition.ts:1`):

   ```ts
   export function buildOpencodeArgs(o: { model?; sessionId?; variant?; agent? }) {
     const a = ["run", "--format", "json"];
     if (o.model) a.push("--model", o.model);
    if (o.sessionId) a.push("--session", o.sessionId);
    return a;
  }
  ```

   MCP servers (Phase 21) ride `CreateSessionOptions.mcpServers` (`src/definition/mcp.ts:1`) — translate per adapter, never leak the wire shape: claude `--mcp-config` temp file (session-owned, deleted on close) + scoped `--allowedTools mcp__<server>__*`; opencode CLI `OPENCODE_CONFIG_CONTENT` env (merged over `process.env` — spawn replaces); ACP `mcpServers[]` in `session/new` + `session/load` (`buildAcpMcpServers`). No support (codex) → throw `RuntimeSessionError`, never silently drop.

   Workspace constraints (Phase 23) ride `CreateSessionOptions.workspace` (`src/definition/workspace.ts:1`) — `allowedPaths` → claude `--add-dir` / codex `-C`, `permissionMode` → `--permission-mode`, `dangerouslySkipPermissions` → `--dangerously-skip-permissions`, `sandboxMode` → `--sandbox` or `-c sandbox_mode`. Paths are `resolve()`d against `cwd` (or `process.cwd()`), deduped, filtered. Opencode/ACP has no native flag — accepted but ignored (never error). `permissionMode:"bypassPermissions"` is the open-design replication (trusted workspace); `dangerouslySkipPermissions:true` is an explicit dangerous alias.

   Permissions (Phase 24/29): ACP `agent → client` requests (`session/request_permission`, `fs/*`) are served via `CreateSessionOptions.onPermissionRequest` (`src/definition/permission.ts:1`). When installed, `AcpTransport` delegates to the handler and returns `{optionId}`; otherwise `-32601` (never stall). Claude interactive `AskUserQuestion` is mapped to `permission_request` (`runtimes/claude/parser.ts:1`) and auto-answered via the same `onPermissionRequest` with `keepStdinOpen` duplex (`src/core/run.ts:1`); bypass mode (`permissionMode:"bypassPermissions"` or `dangerouslySkipPermissions:true`) skips the prompt entirely.

   Usage/cost (Phase 25): parsers emit `usage` (`src/events/runtime-event.ts:1`) — ACP `usage_update`, Claude `result.usage|total_cost_usd`, Codex `turn.completed.usage`, plus generic `{"type":"usage"}`. ACP `result.usage` is also surfaced in `AcpRun.finishTurnOk` before `done`.

3. **Parser** (`parser.ts`): implement `RuntimeParser` (Rule 4 — no process control). Reuse `JsonlParser` for JSONL streams; handle partial chunks, coalesced lines, illegal JSON, unknown types, empty input. Extend for agent quirks (e.g., `runtimes/opencode/parser.ts:1` normalizes `part.text` and `step_start/finish`).

4. **Runtime** (`runtime.ts`): extend `DefaultRuntime` or implement `AgentRuntime` (`src/core/runtime.ts:1`). Override `buildArgs()` and `createParser()`; keep `detect()` via `discovery/executable.ts` + `discovery/version.ts`.

5. **Fixtures** (`fixtures/*.jsonl`): add samples `text.jsonl`, `tool.jsonl`, `error.jsonl`, `done.jsonl`, `mixed.jsonl`, `illegal.jsonl`, `unknown.jsonl`, `empty.jsonl`, plus a `real-<agent>.jsonl` captured from `command run --format json`. Each must parse to `RuntimeEvent[]` only.

6. **Register** (with a concrete factory — otherwise `resolve()` yields a
   generic `DefaultRuntime` stub without your wired `createSession`):

   ```ts
   import { RuntimeRegistry } from "agent-runtimes";
   import { myDefinition } from "./runtimes/my-agent/definition.js";
   import { MyRuntime } from "./runtimes/my-agent/runtime.js";
   const registry = new RuntimeRegistry();
   registry.register(myDefinition, () => new MyRuntime());
   const runtime = await registry.resolve("my-agent");
   ```

   Then add the adapter to the `runtimes` facade in `src/runtimes.ts`
   so `runtimes.resolve("my-agent")` works out of the box.

7. **Tests**:
   - `tests/<id>.test.ts`: `buildArgs` cases + `fixtures/*.jsonl → Parser → RuntimeEvent[]` (cover `Dev_Docs:1049-1062`).
   - `tests/integration/<id>.test.ts`: `resolve → detect → spawn → events → done → cleanup` with real CLI (skip if not installed).

8. **Docs**: update `docs/architecture.md` if new capability or transport is needed; otherwise no core changes.

## Checklist

- [ ] No `if (runtime.id === "...")` in `src/core/**` (Rule 1)
- [ ] No CLI flags leaked to public API (Rule 2)
- [ ] Transport does not parse; Parser does not manage lifecycle (Rules 3/4)
- [ ] `Session !== Process` demonstrated via `tests/session.test.ts` pattern
- [ ] `RuntimeEvent` is agent-agnostic (Rule 6)
- [ ] Cross-platform clean (`docs/cross-platform.md`): stdin/file preferred for prompt delivery, `ExecutableDefinition.aliases` covers per-OS binary names, no hardcoded paths/env, fixtures include a `\r\n` variant
- [ ] MCP (if applicable): servers flow via `mcpServers` only; temp files/env cleaned on close; unsupported runtimes reject loudly
- [ ] Authentication: `auth()` via a native read-only probe (never interactive login); probe failure is `unknown`, never a false logged-out; no secrets in `detail`
- [ ] Workspace: `workspace` flows via `CreateSessionOptions.workspace` only; flags gated via `probeHelpFlags`/`capabilitiesProbed`; paths normalized via `normalizeWorkspaceAllowedPaths`
- [ ] Permissions: bypass via `permissionMode:"bypassPermissions"` (open-design) or `dangerouslySkipPermissions:true`; interactive via `onPermissionRequest` + `permission_request` event + `respondToPermission` duplex, never stall
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` green
