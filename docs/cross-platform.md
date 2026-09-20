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
  `shell: false` (`spawn EINVAL`). Every adapter resolves through the shared
  `resolveLaunch()` (`src/discovery/launch.ts`): shim → host node + script,
  native binary → passthrough. `detect()` reports the shim path (what the
  user installed); `createSession()` and all probes spawn through the launch
  — never re-resolve the bare name at spawn time (bare-name resolution can
  drift to a different, stale shim). Never reimplement per adapter (Rule 7).
- `findExecutable` compares **all** candidates — every `where` row on
  Windows, every `which -a` hit on POSIX, plus known install locations and
  `toolchainProbePaths()` — by probing `--version` and returns the newest.
  With a single candidate there is exactly one probe. If no candidate
  reports a version, the first PATH hit is returned (`installed:true`,
  `version:null`).
- **Policy decision (newest-wins retained, conscious divergence from
  open-design's PATH-order-first):** dev-machine PATHs routinely have stale
  shims ranked ahead of good installs (hence `.exe > .cmd` above); newest
  invocable wins regardless of order. Proven-dead paths are remembered for
  60s (`rememberUnusableExecutable`, skipped on rescan) so only live
  candidates pay probe spawns — PATH order stays in charge of everything
  still standing, and `forgetUnusableExecutables()` forces a rescan.
- Known install locations outside PATH live in each adapter's
  `ExecutableDefinition.extraProbePaths` (absolute or `~`-prefixed, resolved
  by `resolveExtraProbePaths()`; nonexistent entries are skipped, so
  platform-specific paths like the macOS Codex.app bundle are harmless
  elsewhere). They are consulted after PATH hits and participate in the same
  newest-version pick — including with zero PATH hits (app-bundle-only
  installs). Home directories resolve from env
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
- GUI-launched hosts (macOS `.app`, Linux `.desktop`, Electron) inherit a
  minimal `PATH`: extend both discovery and spawn env with
  `userToolchainBinDirs()` (Homebrew, `~/.local/bin`, `~/.bun/bin`, npm
  globals, nvm versions — `src/discovery/toolchain.ts`). Resolution and spawn
  `PATH` must stay symmetric, or a resolved binary dies on a missing shebang
  interpreter. Appended, never prepended — explicit user order keeps winning.
- Win32 npm `.cmd`/`.bat` shims are never spawned directly (`spawn EINVAL`).
  Every adapter resolves through `resolveLaunch()`
  (`src/discovery/launch.ts`: shim → host node + script, native → passthrough)
  for sessions and all probes — never reimplement per adapter.

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
2. CI workflow exists (`.github/workflows/ci.yml`) but the repo has no
   pushed commits yet — the macOS/Linux legs have never gone green.
   Do not claim support until the matrix is green.
