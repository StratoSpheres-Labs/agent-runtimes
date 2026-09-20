# agent-runtimes

[English](./README.md) | 中文

`agent-runtimes` 是一个 Node.js/TypeScript 兼容层，通过统一的 `Runtime → Session → Run → RuntimeEvent` API，把本地 Agent CLI 的发现、启动、控制与观测方式统一起来。

> [!WARNING]  
> agent-runtimes 目前为早期技术预览，推荐使用 Windows 平台以获得更好的使用体验。macOS 和 Linux 的支持仍在持续优化中，在此之前它们的适配性和稳定性可能略低于 Windows。

开发者文档：[文档](./docs/dev/READDEVDOC_CN.md)

## 支持的 runtime

| ID             | Agent            | 会话续接                    | 实时模型       | 认证探测                  | MCP 发现         |
| -------------- | ---------------- | --------------------------- | -------------- | ------------------------- | ---------------- |
| `opencode`     | OpenCode CLI     | `-s`（capture 式）          | `models`       | `auth list` + `auth.json` | `mcp list`       |
| `opencode-acp` | OpenCode via ACP | `session/load`              | —              | —                         | 经 `session/new` |
| `claude`       | Claude Code      | `--resume`（capture 式）    | 静态别名¹      | `login status`            | `mcp list`       |
| `codex`        | Codex CLI        | `exec resume`（capture 式） | `debug models` | `login status`            | `mcp list`       |

¹ Claude Code 没有 list-models 子命令，因此 `sonnet` / `opus` / `haiku`（+ `claude-*-4/5-*` 全名）为手工维护的静态表。

四个 runtime 都提供只读发现接口——`models()`、`auth()`、`mcp()`、`skills()`、`plugins()`——只给元数据，从不给文件内容。拿不到就报 `"unknown"` / `[]`，绝不用过期静态表冒充。

## 安装

要求 `Node.js >= 20`。

```bash
git clone <this-repo> && cd agent-runtimes
pnpm install && pnpm build
```

> 尚未发布到 npm——首个 release 之前 `pnpm add agent-runtimes` 解析不到。请用本地路径引用或 `pnpm link`。

## 用法

```ts
import { runtimes } from "agent-runtimes";

const runtime = await runtimes.resolve("opencode"); // 或 "claude" / "codex"
const status = await runtime.detect(); // { installed, executable, version }
if (!status.installed) throw new Error("agent CLI not found");

const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("分析这个项目，并描述它的结构");

for await (const event of run.events()) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else if (event.type === "tool_started") console.log(`[tool] ${event.name}`);
  else if (event.type === "done") break;
}
await session.close();
```

会话横跨多个进程（`Session !== Process`）：每次 `run()` 起新进程，续接走 agent 原生会话。`run.cancel()` / `session.cancel()` 取消——清理是彻底的（stdio、子进程、监听器、定时器）。

几个值得知道的会话规则：

- **一个会话同时只跑一个 run**——前一个没结束就调第二个 `run()` 会抛 `RuntimeSessionError`（绝不悄悄取消）。等第一个 `result()` 或显式 `cancel()` 后再调。
- **取消以 `done` 收尾**——`run.cancel()` 关流前会补一个带 kill 信号的终态 `done`，“取消成功”和“流断了”分得清。光 `close()` 是静默收尾，不发事件。
- **每个事件都带 `runId`**（`<sessionId>:run<N>`，线上传输可选），多会话穿插时可分组归位；AI 的思考过程走 `reasoning_delta`，绝不混进 `text_delta`。

## CLI

检查某个 runtime 的健康状况（只有当它无法运行时退出码才非零）：

```bash
node dist/cli.js doctor opencode
node dist/cli.js doctor claude
node dist/cli.js doctor codex
```

输出示例：

```
Model             ✓  175 model(s) across 3 providers: opencode , deepseek...
MCP               ✓  2 server(s): github, firecrawl
```

## 功能

- **发现** —— PATH + 别名 + `*_BIN` 覆盖 + 已知安装位置；选最新可调用版本；跳过坏 shim。`findAllInstalls()` 列出每个安装（包管理器、版本、是否选中）；按系统识别，外系统 shim 不掺和。
- **会话** —— create / run / resume / cancel / close；原生 id 从事件流捕获并落盘（`~/.agent-runtimes/sessions`，Electron 可用 `setSessionStoreDir` 改位置）。
- **历史** —— 只读会话历史（`session.history()`），从各 CLI 原生转录库折叠而来；压缩条目、`limit`/`since` 分页、失败放空、库内绝不落盘。
- **事件** —— 只暴露与具体 Agent 无关、可 JSON 序列化的 `RuntimeEvent`：`session_started | text_delta | reasoning_delta | tool_started | tool_finished | usage | permission_request | error | done`。从不泄露 stdout/stderr/JSONL。每个事件带可选 `runId`；思考过程是纯展示的 `reasoning_delta`，空思考静默丢弃、不报错。
- **模型 / 认证 / MCP** —— 每个 runtime 实时发现（`models()`、`auth()`、`mcp()`）；拿不到就报 `"unknown"`，绝不用过期静态表冒充。显式模型在创建会话时校验（`isKnownModel`——拼错在 spawn 之前就被拒）；opencode `--variant` 只发真实存在的档位。
- **技能 / 插件** —— 只读元数据发现（`skills()`、`plugins()`）：全局 + 项目根目录、marketplace id、版本、启用状态。从不读文件内容。
- **版本与诊断** —— 每个 adapter 的 CLI 版本策略（`untested-version` 警告）；`doctor` 每行带机器可读的 `reason` 码（`not-on-path`、`shim-broken`、`auth-missing`……），直接显示。registry 有新版时 Version 行追加 `→ 最新版`（`update-available`）。
- **按能力分支，不按名字** —— 检查 `runtime.capabilities().sessionResume`，不要写 `runtime.id === "claude"`。
- **护栏** —— 图片（路径优先）、工作区 allowlist / 沙箱 / permission-mode 门控、prompt 长度预算、交互式权限请求（`AskUserQuestion` / ACP）、日志与错误详情不含密钥。

## 开发

```bash
pnpm build      # tsup → dist/
pnpm lint       # eslint（flat + typescript-eslint strict）
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
```

顺序很重要：`build → lint → typecheck → test`（合并前四道门禁必须全过）。

- `docs/development.md` / `docs/development.zh-CN.md` —— 环境、测试分层、新增 runtime、排错。
- `docs/architecture.md` —— `Runtime ≠ Session ≠ Run ≠ Transport ≠ Parser` 模型与七条硬规则。
- `docs/frontend.md` —— 给 UI 消费方的线上传输约定：NDJSON 分帧、`runId` 归因、`reasoning_delta`、取消语义。
- `docs/runtime-authoring.md` —— 如何新增 `runtimes/<id>/` 作为架构压力测试。
- `AGENTS.md` —— 仓库约定、目录结构、测试要求。

## 项目结构

```
src/core/         # runtime、session、run、registry、lifecycle、session-store —— 与具体 Agent 无关
src/definition/   # identity、executable、input、transport、session、capability、model、mcp、auth ……
src/events/       # RuntimeEvent、EventStream
src/transport/    # RuntimeTransport + StdioTransport + AcpTransport
src/parser/       # RuntimeParser + JSONL 实现（半包安全）
src/discovery/    # executable / version / models / mcp / auth 探测
src/doctor.ts     # doctor 报告 + summarizeModels
src/cli.ts        # agent-runtimes doctor
runtimes/opencode/ | claude/ | codex/ | opencode-acp/  # definition、parser、runtime、session、fixtures
tests/  examples/basic.ts  docs/
```

## 许可证

Apache-2.0 —— 见 [LICENSE](./LICENSE)。
