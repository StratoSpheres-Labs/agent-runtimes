# Parity — what is built, what is gapped

Honest inventory of the library against its own contracts. Legend:
**done** (implemented + tested), **partial** (works with a named gap),
**deferred** (intentionally not built — each carries why + reopen condition).
`live <version>` means verified against a real CLI on this machine, not just
a fixture. No line numbers below (they drift) — file + symbol names only.

## §1 Capability matrix (source: `capability.ts`)

Rows are the 15 `RuntimeCapabilities` flags; cells name the native channel
or the loud rejection. `false` never means "ignored" — unsupported inputs
throw `RuntimeSessionError` at `createSession` (see `assertSessionInputsSupported`).
`live` is claimed only where a real turn/probe ran on this machine; anything
else names the mechanism with unit/fixture coverage. Codex cells were earned
on 0.157.1 — 0.158.0 shows identical flags plus a working `exec`, full-turn
re-verification deferred (§4).

| Capability       | opencode                                                                                                                                        | claude                                                                             | codex                                                            | opencode-acp                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| streaming        | done (`run --format json`, live 2.0.18)                                                                                                         | done (`stream-json`, live 2.1.283)                                                 | done (`exec --json`, live 0.157.1)                               | done (JSON-RPC, live 2.0.18 server)                                   |
| sessionResume    | done (`--session`, live 2.0.18)                                                                                                                 | done (`--resume`, live 2.1.283)                                                    | done (`exec resume`, live 0.157.1)                               | done (`session/load`, live 2.0.18 server)                             |
| modelSelection   | done (`--model`, live 2.0.18 incl. explicit-model turn)                                                                                         | done (`--model`, live 2.1.283 incl. explicit-model turn)                           | done (`--model`, live 0.157.1; explicit-model turn live 0.158.0) | done (`set_model` → `set_config_option` fallback, live 2.0.18 server) |
| reasoning        | partial (`--variant` on 1.x; `--model id#variant` inline on 2.x — omitted without catalog evidence, omit path live 2.0.18, inline unit-covered) | done (`--effort`; thinking-block mapping fixture-covered)                          | done (`-c model_reasoning_effort`; flag sent, unit-covered)      | rejected (no channel)                                                 |
| images           | done (`-f` staged files, live 2.0.18)                                                                                                           | done (base64 stdin; envelope unit-covered)                                         | done (`-i` staged files; flag path unit-covered)                 | done (prompt parts; envelope unit-covered)                            |
| workspace        | rejected (no channel)                                                                                                                           | done (`--add-dir` / `--permission-mode`; flags advertised, unit-covered)           | done (`--sandbox` / `-C`; flags advertised, unit-covered)        | rejected (no channel)                                                 |
| agentSelection   | done (`--agent`; flag advertised, unit-covered)                                                                                                 | done (`--agent`, live 2.1.283)                                                     | rejected                                                         | rejected                                                              |
| midRunInput      | rejected (stdin carries one prompt)                                                                                                             | rejected (print mode consumes initial prompt only)                                 | rejected (stdin carries one prompt)                              | done (`session/prompt` steering; mock + protocol unit-covered)        |
| historySeed      | rejected everywhere (reserved, no transcript-injection channel — fold caller-side)                                                              | rejected                                                                           | rejected                                                         | rejected                                                              |
| subAgents        | done (`session.parent_id` → child transcript, tied to its `task` call; live 65/76 children, opt-in `includeSubAgents`)                          | rejected (sidechain files exist; the link to the spawning call is unverified — §4) | rejected (zero real `spawn_agent` calls in 175 rollouts — §4)    | done (same store and reader as `opencode`)                            |
| systemPrompt     | rejected                                                                                                                                        | done (`--append-system-prompt`; envelope unit-covered)                             | rejected                                                         | rejected                                                              |
| maxTokens        | rejected everywhere (reserved — claude has spend not tokens, codex knob probed `ignored`)                                                       | rejected                                                                           | rejected                                                         | rejected                                                              |
| costBudget       | rejected                                                                                                                                        | done (`--max-budget-usd`; flag unit-covered)                                       | rejected                                                         | rejected                                                              |
| structuredOutput | rejected                                                                                                                                        | done (`--json-schema` inline, live 2.1.283)                                        | done (`--output-schema` staged file, live 0.157.1)               | rejected                                                              |
| toolAllowlist    | rejected                                                                                                                                        | done (`--allowedTools` merged; builder unit-covered)                               | rejected                                                         | rejected                                                              |
| profileSelection | rejected                                                                                                                                        | rejected                                                                           | done (`-p`; flag unit-covered)                                   | rejected                                                              |

## §2 Discovery surfaces (per runtime: mechanism + honesty)

| Surface          | opencode                                                                                                                             | claude                                                           | codex                                          | opencode-acp                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| auth             | done (`auth list` table + tree parse, `auth.json` fallback, live 2.0.18)                                                             | done (oauth probe, live 2.1.283)                                 | done (ChatGPT auth probe, live 0.158.0 doctor) | done (shares opencode store)              |
| models           | done (plain `models`; `--verbose` gone on 2.x — no variant metadata, live 2.0.18)                                                    | done (static list; deterministic, no live turn needed)           | done (live list, live 0.158.0 doctor)          | done (shares opencode catalog)            |
| mcp              | partial (`mcp list` + `OPENCODE_CONFIG_CONTENT` env honored on 2.x; 2.x `mcp list` misses file-configured servers, reports honestly) | done (`mcp list` + `--mcp-config`; builder + probe unit-covered) | unsupported (loud reject)                      | done (`mcpServers[]`, live 2.0.18 server) |
| skills / plugins | done (file scan, read-only metadata)                                                                                                 | done (file scan)                                                 | done (file scan)                               | done (shares opencode roots)              |
| history          | done (native transcript fold; fixture-covered)                                                                                       | done (`~/.claude` transcript fold; fixture-covered)              | done (rollout fold; fixture-covered)           | done (shares opencode store)              |
| doctor           | done (all rows incl. fail-open Version + reason codes; live current versions)                                                        | done                                                             | done                                           | done                                      |

## §3 Hardening (done vs partial)

Done: SIGTERM→1s→SIGKILL escalation with timers unref'd; terminal `done` on
every path (cancel/timeout/crash, double-`done` impossible); `EventStream`
10k cap + 4MB parser buffers (`done` always flows); zero-zombie
cancel/close (listeners/timers/buffers reaped); parser-throw → `PARSER_ERROR`
event (never host crash); `TIMEOUT` identity preserved stdio+ACP;
stdin-EPIPE → event (never unhandled rejection); ACP circular results →
`-32601`/`-32603` answers; argv sanitizers (model/config/tool/resume ids);
image byte caps + staging containment; version floors + `tested` tables +
fail-open doctor; 14-code error taxonomy (switch, never string-match);
injected `RuntimeLogger` (silent default) across lifecycle/transports/runs;
run journal write path (NDJSON, torn-tail tolerant, 8MB compact, 30d retain);
history desensitized by default (`redactSecrets` over vendor-key/k=v/bearer
shapes, explicit `redacted` flag, `includeRawInputs` opt-out);
per-session run queue (`queue:true` FIFO on observed `done`, abort signal,
poison-skip, close-flush; prompts in-memory only);
stall watchdog (`stallTimeoutMs` per run, `STALL` + cancel, stdio + ACP);
idle reaper (`idleTimeoutMs` per session, busy re-arms) + host-wide
`shutdownAllSessions()` (weak-tracked, per-session errors isolated).

Partial:

- Journal replay not wired into sessions (write + read + detect + stamp
  ship; `replayJournalEvents` awaits session integration).
- Per-session run queue ships in-memory: FIFO dispatch on observed `done`,
  abort-before-dispatch via signal, poison entries skip through, close
  flushes. Queued prompts are never journaled.
- opencode-2.x reasoning without catalog evidence omits and runs base
  silently (fail-open by design, but the downgrade itself is invisible —
  a future `reasoning_downgraded` note is the honest shape).
- Session store is a best-effort hint cache (documented) — resume after a
  failed save depends on the journal, not the record.

## §4 Deferred (intentionally not built)

Each carries why + reopen condition. No reason, no entry.

- **Soak evidence** — why: bursts verified, multi-hour runs not. Reopen:
  before any durability SLA claim.
- **CJS dual build** — why: ESM-only is fine on Node ≥ 20; CJS compat costs a
  second bundle. Reopen: first CJS consumer asks.
- **Metrics/tracing hooks** — why: logger covers diagnostics; OTel shape
  belongs to the upper project. Reopen: upper project standardizes on OTel.
- **E2E two-machine smoke** — why: single-host library, no peer protocol.
  Reopen: never (upper-layer concern by architecture).
- **Pending CLI re-verification** — claude 2.1.284 + codex 0.159.0 available
  at 0.1.2 ship time; deferred by explicit decision (ship with fail-open
  rows, follow next round).
- **macOS CI fleet** — infra note, not product: `macos-latest` (Tahoe 26)
  repeatedly kills jobs with `runner shutdown signal`, zero failing
  assertions; test step retries once. Reopen: fleet stabilizes → remove retry.
- **Truncating a conversation (Checkpoints)** — why: every CLI resume path
  only _extends_ a session; there is no flag to truncate a prefix, so a UI
  cannot rewind. Reopen: a CLI ships a truncate/revert flag (would need a new
  capability flag + `buildArgs()` work in all adapters).
- **Span-level tracing (Trace waterfall)** — why: the parser is a `RuntimeEvent`
  translator and has no span concept; the run journal records events, not
  spans. Reopen: a runtime emits span boundaries, or an upper layer accepts
  event-level granularity.
- **Cross-run analytics (Activity / Heat graph)** — why: the run journal holds
  the events, but indexing them into a run-count calendar is a query problem
  that belongs to the upper layer. Reopen: an upper layer wants it in-library.
- **Subagent / GUI (Subagent list, Computer use)** — why: local CLIs stream one
  flat turn over stdio or ACP; neither carries subagent identity or screen
  frames. Reopen: a protocol exposes them.

### Sub-agent transcripts (`history()` nesting) — partial by runtime

Done for **opencode** (and **opencode-acp**, same store and reader).
`RuntimeCapabilities.subAgents` is the gate; `HistoryOptions.includeSubAgents`
is opt-in (default off — nesting multiplies returned text and inherits the
parent's pasted-secret exposure) and `maxDepth` defaults to 2.

Correlation is child→spawning-`task`-call via the child session id embedded in
that call's own output, paired with `session.parent_id`. Children with no
matching `task` part are **dropped, not guessed onto a neighbouring call**:
measured live, 65 of 76 children tie cleanly and 11 do not (the parent's task
part is absent), and a wrong parent is undetectable downstream.

Not done, with `subAgents: false` on both:

- **claude** — side-chain turns do exist, as sibling `agent-<id>.jsonl` files
  tagged `isSidechain`, but the link back to the spawning tool call is
  **unverified**: 1 of 93 transcripts here has sidechain entries, its
  `sourceToolAssistantUUID` resolves to a message _inside_ the sidechain file
  (a `Bash` call, not a `Task` call), and the parent transcript is absent.
  Reopen: capture a real `Task`-tool turn and re-probe the linkage.
- **codex** — nothing to read. Zero real `spawn_agent` calls across 175
  rollouts (the 77 textual hits are aspirational system-prompt copy) and
  `session_meta` carries no parent link.

The assistant-ui adapter does not yet fold `subAgents` into
`ToolCallMessagePart.messages`; it needs a BFF history route first. Reopen:
one route, then the fold.

## §5 Chat-UI adapters (done vs deferred)

`@stratosphereslab/agent-runtimes/assistant-ui` is a browser-safe subpath with
its own build. Done: the `RuntimeEvent` → message fold (text, reasoning, tool
calls, approval gate, denial, error, usage, done), SSE + NDJSON stream readers
(partial-chunk and multi-byte safe, fail-open on an undecodable line via
`onProtocolError`), the four-route `fetch` transport, both runtime entry points
(`useExternalStoreRuntime` via a framework-free `ThreadStore`, `useLocalRuntime`
via a `ChatModelAdapter`), and a `data-*` channel for structured cards. The
snapshot carries `loadState` / `runState` (with `cancelling` distinct from
`streaming`), `droppedParts`, `unhandledEvents`, and a ready-made
`metadata.timing`. Covered against the real `@assistant-ui/core` types at
compile time; import-graph guarded against `node:` leakage.

Deferred there: anything listed in §4 above (Checkpoints, Trace waterfall,
Activity/Heat graph, Subagent list, Computer use), plus multi-thread as a
first-class `RemoteThreadListAdapter` — `listSessionRecords()` is a resume
_hint_ cache, so it can seed a thread list but must not be presented as the
source of truth.

**Deliberately not wired: `onEdit` / `onReload` / `onResume`** (edit,
regenerate, branch switching). Every CLI resume path only extends a session, so
wiring them would produce a UI that looks right and is wrong about the agent's
context — see §4 "Truncating a conversation". The buttons are absent rather
than broken.

**Partial: the approval gate is claude-only.** `permission_request` is emitted
by exactly one parser (`runtimes/claude/parser.ts`), and claude is the only
runtime whose `PermissionRequest` carries an `id` a backend can correlate a UI
answer with. ACP has neither an event nor an id, so a UI approval round trip
there always fails. Reopen: an ACP turn emits a permission request with a
stable id, and `AcpRun` grows a `respondToPermission` slot.

## Maintenance (the part that makes this file true)

1. **Release gate**: tagging requires a PARITY pass — new capability,
   rejected input, or verified version lands in the table first
   (same ritual as `pnpm compat:record`).
2. **Review gate**: code-review Spec axis checks "new capability →
   PARITY row".
3. **Accepted stamp**: every deferred entry keeps its why + reopen line.
   A gap without a reason is a bug in this file, not a plan.
