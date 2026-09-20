# Install

Requires `Node.js >= 20` and `pnpm`.

```bash
git clone <this-repo> && cd agent-runtimes
pnpm install && pnpm build
```

> Not published to npm yet — consume via local path or `pnpm link` until
> the first release.

## Verify

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

Order matters: `build → lint → typecheck → test`. Plus
`pnpm format:check` before merge.

Then check the CLIs on your machine (any subset works — missing ones
skip gracefully):

```bash
node dist/cli.js doctor opencode
node dist/cli.js doctor claude
node dist/cli.js doctor codex
```

A healthy row looks like:

```
Executable   ✓  C:\...\npm\node_modules\opencode-ai\bin\opencode.exe
Version      ✓  1.18.31
Installs     ✓  npm 1.18.31 (selected)
```

## Installing the CLIs themselves

Any manager works — the library recognizes npm/pnpm/bun/winget installs
and picks the newest invocable copy per CLI (see
[Installs](../discovery/installs.md)):

```bash
npm install -g opencode-ai @anthropic-ai/claude-code @openai/codex
# or: pnpm add -g ... / bun add -g ... / winget install ...
```

> pnpm note: global installs need `--allow-build=<pkg>` for CLIs shipping
> native binaries (their `postinstall` downloads the real `.exe`, and pnpm
> blocks install scripts by default — without it you get a 0 KB stub).

## When something is wrong

- `not found on PATH` — install the CLI or point `*_BIN` at it
  (`OPENCODE_BIN`, `CLAUDE_BIN`, `CODEX_BIN`).
- `shim-broken` — a `.cmd` shim whose target vanished; reinstall that copy.
- Full troubleshooting: `docs/development.md`.
