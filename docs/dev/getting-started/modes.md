# Mode Map

"Plan mode" means three different things on three CLIs. This page is the
only translation table: user words on the left, library fields on the
right. Contract details live in [frontend.md](../../frontend.md);
per-flag verification notes live in each `runtimes/<id>/definition.ts`.

## The rule: two axes, never one "mode"

- **Permission** (what the agent may do): read-only vs may-write. A
  safety boundary — misconfiguring it writes to the wrong disk.
- **Agent** (who does it): a named behavior preset (`plan`, `build`,
  …). A behavior choice — same name, different content per project.

There is deliberately no unified `mode: "plan" | "build"` field: Claude's
plan (a permission bit) is not Codex's read-only (sandbox + approval
policy) is not OpenCode's plan-agent (a prompt preset). One enum would
lie about at least one runtime on every call.

## "I want read-only / plan" per runtime

| You say              | Library field                                     | Native effect                                                                                                                       |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude read-only     | `workspace: { permissionMode: "plan" }`           | `--permission-mode plan`                                                                                                            |
| Codex read-only      | `workspace: { sandboxMode: "read-only" }`         | `--sandbox read-only` (create) / `-c sandbox_mode="read-only"` (resume)                                                             |
| OpenCode read-only   | — no channel                                      | `workspace` is rejected loudly (`workspace: false`, verified against `opencode run --help`)                                         |
| OpenCode via ACP     | — no flags                                        | permissions are interactive (`onPermissionRequest` / `respondToPermission`), never flags                                            |
| Codex auto-review    | `workspace: { autoReview: true }`                 | `--approve-for-me` (forces `workspace-write` + `on-request`; conflicts with `sandboxMode`/`dangerouslySkipPermissions` throw first) |
| Full-throttle escape | `workspace: { dangerouslySkipPermissions: true }` | Claude `--dangerously-skip-permissions` / Codex `--dangerously-bypass-approvals-and-sandbox`; unsupported runtimes reject loudly    |

Notes:

- Values pass through **verbatim, unvalidated** (only capability
  support is gated at `createSession`). A misspelled `permissionMode`
  fails late at spawn with the CLI's own error — check the native
  `--help` for the value list, the library will not correct you.
- Codex sandbox has a platform default: explicit `sandboxMode` always
  wins, otherwise `OD_CODEX_SANDBOX= danger-full-access` env, else
  `danger-full-access` on win32/WSL and `workspace-write` on POSIX
  (no working OS sandbox on Windows — verified).
- The closest OpenCode gets to "plan" is `agent: "plan"` below — a
  behavior preset, **not** a permission boundary. Do not mistake one
  for the other.

## "I want the plan/build agent" per runtime

| Runtime          | Library field                     | Native effect                           | Name source                                                          |
| ---------------- | --------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| OpenCode         | `agent: "plan"` (or `"build"`, …) | `--agent <name>`                        | workspace config — **untrusted input**, pass-through + argv sanitize |
| Claude           | `agent: "<name>"`                 | `--agent <name>` (verified on 2.1.278)  | same as above                                                        |
| Codex            | — none                            | no `--agent` channel                    | n/a                                                                  |
| OpenCode via ACP | — none                            | conductivity is permissions, not agents | n/a                                                                  |

Agent names are not portable: repo A's `plan` is a different file from
repo B's `plan`. The library transmits the string, never vouches for
its content. Same typo rule as above: unknown names fail at spawn.

## Neighboring knobs (same session options bag)

- `allowedPaths` — Claude `--add-dir`, Codex `-C` (create-only);
  runtimes without the channel reject loudly.
- `allowedTools` — Claude `--allowedTools` only (sanitized per entry;
  a dropped entry would silently widen access).
- `systemPrompt` — Claude `--append-system-prompt` only, append never
  replace.
- `reasoning.effort` — unified `low|medium|high` → Claude `--effort`,
  Codex `-c model_reasoning_effort=`.

## Gaps (expressible nowhere — candidate fields, one at a time)

- Codex standalone approval policy (`--ask-for-approval
untrusted|on-failure|on-request|never`): only reachable today via
  `autoReview`'s forced `on-request`.
- Value catalogs for `permissionMode`/`sandboxMode` (fail-early
  validation like `isKnownModel`): no live list channel verified, so
  typos still fail at spawn.
- Anything permission/sandbox on `opencode run`: no native flag exists.

A gap becomes a field only with a verified native channel + capability
gate + loud reject — never a cross-runtime preset name.

## Next

- [Quickstart](./quickstart.md) — the session flow these fields plug into.
- [BFF](./bff.md) — what the layer above does with them.
- [Frontend contract](../../frontend.md) — error codes when a mode rejects.
