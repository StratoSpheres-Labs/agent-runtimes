# 安装

要求 `Node.js >= 20` 和 `pnpm`。

```bash
git clone <this-repo> && cd agent-runtimes
pnpm install && pnpm build
```

> 还没发 npm——首个 release 之前用本地路径引用或 `pnpm link`。

## 验证

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

顺序重要：`build → lint → typecheck → test`。合并前再加 `pnpm format:check`。

然后检查本机 CLI（装了哪个都行，缺的会自动跳过）：

```bash
node dist/cli.js doctor opencode
node dist/cli.js doctor claude
node dist/cli.js doctor codex
```

健康长这样：

```
Executable   ✓  C:\...\npm\node_modules\opencode-ai\bin\opencode.exe
Version      ✓  1.18.31
Installs     ✓  npm 1.18.31 (selected)
```

## 装 CLI 本体

哪个包管理器都行——库认得出 npm/pnpm/bun/winget 的安装，每个 CLI 自动选最新可用的（见[安装发现](../discovery/installs.md)）：

```bash
npm install -g opencode-ai @anthropic-ai/claude-code @openai/codex
# 或：pnpm add -g ... / bun add -g ... / winget install ...
```

> pnpm 注意：带原生二进制的 CLI 要加 `--allow-build=<包名>`，否则 postinstall 被拦，下来的 `.exe` 是 0KB 空壳。

## 出问题时

- `not found on PATH`——装 CLI，或用 `*_BIN` 指过去
  （`OPENCODE_BIN`、`CLAUDE_BIN`、`CODEX_BIN`）。
- `shim-broken`——`.cmd` 垫片的目标没了，重装那一份。
- 完整排错见 `docs/development.md`。
