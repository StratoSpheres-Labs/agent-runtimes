# Cross-Platform Guide

Target: **Windows (primary dev machine) + macOS + Linux** on Node.js >= 20.
Every rule below exists because `spawn`, PATH, signals, and paths behave
differently per OS. When in doubt, test on all three via the CI matrix (§8).

## 1. Executable discovery (`src/discovery/executable.ts`)

- Probe with `where` on Windows, `which` on POSIX. Never parse `PATH`
  manually (`;` vs `:` separator, case-insensitive names on Windows).
- On Windows, `where` may return several rows for one command
  (`opencode` bare, `opencode.cmd`, `opencode.exe`). Prefer **`.exe` >
  `.cmd` > bare** — this matches what `spawn(name)` with `shell: false`
  actually executes via PATHEXT.
- npm global shims (`*.cmd`, `*.ps1`) are **not directly spawnable** with
  `shell: false`. Always resolve to the underlying `.exe` (e.g.
  `.../node_modules/opencode-ai/bin/opencode.exe`) before spawning.
  `detect()` must return that resolved absolute path, and `createSession()`
  must spawn it — never re-resolve the bare name at spawn time (bare-name
  resolution can drift to a different, stale shim).
- If only a shim exists (no native `.exe`), `detect()` still reports it
  honestly — the failure then surfaces at spawn time as `RuntimeSpawnError`
  (with a shim hint on Windows), never as a raw `EINVAL` host crash.
- `findExecutable` compares **all** candidates — every `where` row on
  Windows, every `which -a` hit on POSIX, plus the known install
  locations below — by probing `--version` and returns the newest. With
  a single candidate there is exactly one probe. If no candidate
  reports a version, the first PATH hit is returned (`installed:true`,
  `version:null`).
- Known install locations outside PATH are still opencode-specific
  (win32: npm-global `opencode-ai` bundle, bun dirs; POSIX: `~/.bun/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`). This is in tension with Rule 1
  (no agent-specific branching in shared code). Generalize before adding
  the next agent: move fallback locations into `ExecutableDefinition`
  (e.g. `extraProbePaths?: string[]`). Home directories resolve from env
  (`USERPROFILE`/`HOME`, `APPDATA`, `LOCALAPPDATA`) — never hardcode
  usernames or absolute paths.

## 2. Process spawn (`src/core/lifecycle.ts`, `src/discovery/run-command.ts`)

- Always `spawn(cmd, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })`.
  `shell: false` means no shell quoting/injection issues and no `.cmd`
  execution — which is exactly why rule §1 (resolve to `.exe`) matters.
- Pass arguments as an **array**, never a joined command string. Paths with
  spaces then need no quoting on any OS.
- `windowsHide: true` is a no-op on POSIX; keep it unconditionally.

## 3. Signals and termination

- Cancel flow is `SIGTERM → 1s grace → SIGKILL` (`RuntimeProcess.kill`,
  `runCommand` timeout path). On Windows both map to process termination —
  there is **no graceful SIGTERM delivery** to the child, so never rely on
  the agent CLI cleaning up on SIGTERM on Windows.
- `child.kill()` throws if the process already exited — always catch.
- `ProcessExit.signal` is frequently `null` on Windows; branch on
  `exit.code`, not on `signal`.
- Every timer created for timeout/grace must be `unref()`'d so probes never
  hold the event loop open.

## 4. Prompt delivery and argv limits

- Windows `CreateProcess` caps the command line at ~32767 characters.
  Prefer `stdin` (or `file`) for prompt delivery — `PromptInput`
  (`src/definition/input.ts`) exists for this reason.
- A future `maxPromptArgBytes` guard should reject oversized argv prompts
  with an actionable error instead of surfacing `ENAMETOOLONG`/`E2BIG`
  from spawn (open-design enforces this per adapter).

## 5. Stdout/stderr parsing

- Agent CLIs emit `\n` (POSIX) or `\r\n` (Windows console) line endings.
  `JsonlParser` splits on `\n` and trims each line, which covers both —
  keep that invariant in every parser; never split on `\r\n` only.
- Piped child output is raw bytes; decode as UTF-8 (`TextDecoder`).
  Windows console code pages do **not** apply to pipes — do not add
  code-page conversion.
- `stderr` carries logs/diagnostics, not events. Parsers must read
  `stdout` only; surfacing `stderr` as `error` events is reserved for raw
  (parser-less) mode.

## 6. File paths

- Always build paths with `node:path` (`join`, `resolve`) — never
  concatenate with `/` or `\`.
- Never compare paths as plain strings across platforms: Windows (and
  default macOS volumes) are case-insensitive, Linux is case-sensitive.
  Normalize case only for display, never for identity.
- `cwd` may contain drive letters (`C:\...`), UNC prefixes, or spaces —
  all fine with args arrays + `shell: false`. Never quote `cwd`.
- Tests must use `os.tmpdir()` (plus `fs.mkdtemp`) for scratch dirs.
  Hardcoded `C:\Temp`-style paths fail on macOS/Linux.

## 7. Environment variables

- Never forward the whole `process.env` to a child (leaks
  `API_KEY`/`TOKEN` — see `AGENTS.md` §9). Pass an explicit minimal env.
- Home/config locations differ: `USERPROFILE`+`APPDATA`/`LOCALAPPDATA`
  (Windows) vs `HOME` (+ `XDG_CONFIG_HOME`, default `~/.config`) on
  POSIX. Resolve via env with fallback, never hardcode.
- `PATH` lookup must go through `where`/`which`, never manual splitting
  (`path.delimiter` differs and Windows lookup is case-insensitive).

## 8. CI matrix (required before v1.0.0)

`.github/workflows/ci.yml` runs the four gates on this matrix:

```yaml
strategy:
  matrix:
    os: [windows-latest, macos-latest, ubuntu-latest]
    node: [20, 22]
steps:
  - uses: pnpm/action-setup@v4
  - run: pnpm install
  - run: pnpm build
  - run: pnpm lint
  - run: pnpm typecheck
  - run: pnpm test
```

- Unit/fixture tests must pass on all three OSes with **no CLI installed**.
- Integration tests (`tests/integration/`) must skip gracefully when the
  CLI is absent and run for real when present (install `opencode` in at
  least one matrix leg before v1.0.0).

## 9. Known gaps (fix before claiming cross-platform support)

1. No `maxPromptArgBytes` guard for argv-delivered prompts
   (Windows `CreateProcess` ~32767 char limit fails as
   `ENAMETOOLONG`/`E2BIG` instead of an actionable error).
2. Fallback install locations are still opencode-specific — generalize
   into `ExecutableDefinition` (e.g. `extraProbePaths?: string[]`)
   before adding the next agent family (Rule 1 tension).
3. CI workflow exists (`.github/workflows/ci.yml`) but the repo has no
   pushed commits yet — the macOS/Linux legs have never gone green.
   Do not claim support until the matrix is green.
