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

2. **buildArgs()**: implement `buildArgs(options): string[]` that hides all CLI flags (`--resume`, `-s`, `--model`, `--variant`, etc.) — Rule 2. Caller-supplied values that ride argv MUST be validated: `model` goes through `sanitizeModelId()` (`src/definition/model.ts:1`) and invalid ids throw `RuntimeSessionError` — never let a flag-shaped value reach the CLI. Example (`runtimes/opencode/definition.ts:1`):

   ```ts
   export function buildOpencodeArgs(o: { model?; sessionId?; variant?; agent? }) {
     const a = ["run", "--format", "json"];
     if (o.model) a.push("--model", o.model);
    if (o.sessionId) a.push("--session", o.sessionId);
    return a;
   ```

}

````

 MCP servers (Phase 21) ride `CreateSessionOptions.mcpServers` (`src/definition/mcp.ts:1`) — translate per adapter, never leak the wire shape: claude `--mcp-config` temp file (session-owned, deleted on close) + scoped `--allowedTools mcp__<server>__*`; opencode CLI `OPENCODE_CONFIG_CONTENT` env (merged over `process.env` — spawn replaces); ACP `mcpServers[]` in `session/new` + `session/load` (`buildAcpMcpServers`). No support (codex) → throw `RuntimeSessionError`, never silently drop.

 Workspace constraints (Phase 23) ride `CreateSessionOptions.workspace` (`src/definition/workspace.ts:1`) — `allowedPaths` → claude `--add-dir` / codex `--add-dir`, `permissionMode` → claude `--permission-mode`, `dangerouslySkipPermissions` → claude `--dangerously-skip-permissions` / codex `--dangerously-bypass-approvals-and-sandbox`, `sandboxMode` → codex `--sandbox` or `-c sandbox_mode`, `autoReview` → codex `--approve-for-me` (reviewer agent + forced workspace-write, create-only, conflicts with `sandboxMode`/`dangerouslySkipPermissions` — enforced at `createSession` and `buildCodexArgs`). Paths are `resolve()`d against `cwd` (or `process.cwd()`), deduped, filtered. Each adapter declares its wired subset; anything else is rejected loudly at `createSession` via `assertWorkspaceFieldsSupported` (`src/definition/session-inputs.ts:1`) — opencode/ACP wire nothing, claude rejects `sandboxMode`/`autoReview`, codex rejects `permissionMode`. Never silently ignore (the codex-MCP precedent). `permissionMode:"bypassPermissions"` is the open-design replication (trusted workspace); `dangerouslySkipPermissions:true` is an explicit dangerous alias.

 Input surface (batches 1–3): `session.run()` takes `PromptContent` (`string | PromptPart[]`, `src/definition/content.ts:1`); per-run `{model, reasoning, allowMidRunInput}` overrides ride `SessionRunOptions`; `run.send()` steers a live turn on `midRunInput` runtimes (ACP `session/prompt` only — claude print mode consumes just the initial stdin prompt, verified live over 3 runs, so it rejects `send()`); `agent` → opencode/claude `--agent`, `profile` → codex `-p`, caller `allowedTools` merge into claude `--allowedTools`, `systemPrompt` → claude `--append-system-prompt`, `maxBudgetUsd` → claude `--max-budget-usd`, `outputSchema` → codex `--output-schema` (staged file, both branches) / claude `--json-schema` (inline). `maxTokens` / `seedMessages` are reserved options with no wired channel — rejected loudly everywhere. History seeding is a caller-side fold (`foldSeedMessages`, prepended to the first prompt). New session inputs must be capability-gated in `assertSessionInputsSupported` with a test in `tests/input-control.test.ts`.

  opencode 2.x channel map (verified live 2.0.18 — major CLI break): `run` dropped `--dir` (workspace pins via the spawn `cwd` only — the session still passes `cwd` to the child) and `--variant` (variant inlines as `--model provider/model#variant`); `models --verbose` is gone (plain `models` only, no variant metadata — the inline gate requires affirmative catalog evidence and omits otherwise); `auth list` prints a `<name> <API key|OAuth> stored` table (parsed alongside the 1.x `●` tree); `mcp list` prints `No MCP servers configured` when empty (skipped, never a ghost server); ACP dropped `session/set_model` (model rides `session/set_config_option {configId: "model"}`, with `-32601` fallback in `AcpRun.setModel`). `buildOpencodeArgs` takes `cliVersion` (raw `detect().version`) and branches on `isOpencodeV2` (major >= 2); unknown versions fail open to the 1.x set. Output JSONL shapes are unchanged — parsers untouched.

 Token-budget channel map (verified live, 2026-09): claude has `--max-budget-usd` (spend, wired as `maxBudgetUsd`) but no `--max-tokens`; codex `model_max_output_tokens` exists in old config docs but 0.156.1 reports it `ignored` via `-c` (probed live — do not wire); opencode/ACP have nothing. When a vendor adds a real knob, wire it behind the existing `maxTokens` option + `maxTokens` capability (no API change needed).

 Permission-map findings (verified live, 2026-09, opencode 1.18.32): there is no interactive ask channel in `opencode run` (`ask` headless auto-rejects; third parties confirm `ask` is rejected in subprocess mode). What exists: (1) `permission: {tool: "deny"}` hides the tool from the toolset (the agent routes around via bash — advisory, not a cage); (2) `permission: {tool: "ask"}` headless auto-rejects with `tool_use/state.status=error` + `"The user rejected permission …"` (mapped to `permission_denied`); (3) **trap**: `permission: {bash: "deny"}` hard-403s Zen free-tier runs reproducibly (`edit:deny`, `bash:allow`, `mcp`-only all fine) — never expose raw permission maps in the public API without re-probing this. Codex `exec` has no per-call allow/deny knob at all (`--approve-for-me`/bypass only).

 Permissions (Phase 24/29): ACP `agent → client` requests (`session/request_permission`, `fs/*`) are served via `CreateSessionOptions.onPermissionRequest` (`src/definition/permission.ts:1`). When installed, `AcpTransport` delegates to the handler and returns `{optionId}`; otherwise `-32601` (never stall). Claude interactive `AskUserQuestion` is mapped to `permission_request` (`runtimes/claude/parser.ts:1`) and auto-answered via the same `onPermissionRequest` with `keepStdinOpen` duplex (`src/core/run.ts:1`); bypass mode (`permissionMode:"bypassPermissions"` or `dangerouslySkipPermissions:true`) skips the prompt entirely.

 Usage/cost (Phase 25): parsers emit `usage` (`src/events/runtime-event.ts:1`) — ACP `usage_update`, Claude `result.usage|total_cost_usd`, Codex `turn.completed.usage`, plus generic `{"type":"usage"}`. ACP `result.usage` is also surfaced in `AcpRun.finishTurnOk` before `done`.

3. **Parser** (`parser.ts`): implement `RuntimeParser` (Rule 4 — no process control). Reuse `JsonlParser` for JSONL streams; handle partial chunks, coalesced lines, illegal JSON, unknown types, empty input. Extend for agent quirks (e.g., `runtimes/opencode/parser.ts:1` normalizes `part.text` and `step_start/finish`).

4. **Runtime** (`runtime.ts`): extend `DefaultRuntime` or implement `AgentRuntime` (`src/core/runtime.ts:1`). Override `buildArgs()` and `createParser()`; keep `detect()` via `discovery/executable.ts` + `discovery/version.ts`.

5. **Fixtures** (`fixtures/*.jsonl`): add samples `text.jsonl`, `tool.jsonl`, `error.jsonl`, `done.jsonl`, `mixed.jsonl`, `illegal.jsonl`, `unknown.jsonl`, `empty.jsonl`, plus a `real-<agent>.jsonl` captured from `command run --format json`. Each must parse to `RuntimeEvent[]` only.

6. **Register** (with a concrete factory — otherwise `resolve()` yields a
 generic `DefaultRuntime` stub without your wired `createSession`):

 ```ts
 import { RuntimeRegistry } from "@stratosphereslab/agent-runtimes";
 import { myDefinition } from "./runtimes/my-agent/definition.js";
 import { MyRuntime } from "./runtimes/my-agent/runtime.js";
 const registry = new RuntimeRegistry();
 registry.register(myDefinition, () => new MyRuntime());
 const runtime = await registry.resolve("my-agent");
````

Then add the adapter to the `runtimes` facade in `src/runtimes.ts`
so `runtimes.resolve("my-agent")` works out of the box.

7. **Tests**:
   - `tests/<id>.test.ts`: `buildArgs` cases + `fixtures/*.jsonl → Parser → RuntimeEvent[]` (cover `Dev_Docs:1049-1062`).
   - `tests/integration/<id>.test.ts`: `resolve → detect → spawn → events → done → cleanup` with real CLI (skip if not installed).

8. **Docs**: update `docs/architecture.md` if new capability or transport is needed; otherwise no core changes.

### Permission posture default

Headless runs default to least privilege: no `bypassPermissions` unless the
caller sets `workspace.permissionMode` (or the explicit dangerous alias
`dangerouslySkipPermissions`). MCP sessions pre-approve exactly their own
servers' tools instead of bypassing. This deliberately diverges from
open-design, which hardcodes `--permission-mode bypassPermissions` for daemon
runs — our callers opt into bypass explicitly rather than discovering it
after a destructive turn. Interactive turns use `onPermissionRequest` +
`permission_request` event + `respondToPermission` duplex and never stall.

## Checklist

- [ ] No `if (runtime.id === "...")` in `src/core/**` (Rule 1)
- [ ] No CLI flags leaked to public API (Rule 2)
- [ ] Transport does not parse; Parser does not manage lifecycle (Rules 3/4)
- [ ] `Session !== Process` demonstrated via `tests/session.test.ts` pattern
- [ ] `RuntimeEvent` is agent-agnostic (Rule 6)
- [ ] Cross-platform clean (`docs/cross-platform.md`): stdin/file preferred for prompt delivery, `ExecutableDefinition.aliases` covers per-OS binary names, no hardcoded paths/env, fixtures include a `\r\n` variant
- [ ] MCP (if applicable): servers flow via `mcpServers` only; temp files/env cleaned on close; unsupported runtimes reject loudly
- [ ] Authentication: `auth()` via a native read-only probe (never interactive login); probe failure is `unknown`, never a false logged-out; no secrets in `detail`
- [ ] Workspace: `workspace` flows via `CreateSessionOptions.workspace` only; flag inventory via `probeHelpFlags`/`probeFlags` (doctor Flags row); paths normalized via `normalizeWorkspaceAllowedPaths`
- [ ] Permissions: bypass via `permissionMode:"bypassPermissions"` (open-design) or `dangerouslySkipPermissions:true`; interactive via `onPermissionRequest` + `permission_request` event + `respondToPermission` duplex, never stall
- [ ] Versions: `tested` lists only CLI builds you actually verified; `minimum` only on observed breakage with a `VERSION_FLOORS` entry + proving test (never hand-edit `tested` on upgrade — run `pnpm compat:record`)
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` green
