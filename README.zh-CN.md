# agent-runtimes

![agent-runtimes](./docs/for_README/agent_runtimes_hero_img_ZH.png)

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/StratoSpheres-Labs/agent-runtimes/actions/workflows/ci.yml"><img src="https://github.com/StratoSpheres-Labs/agent-runtimes/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/StratoSpheres-Labs/agent-runtimes/releases"><img src="https://img.shields.io/github/v/release/StratoSpheres-Labs/agent-runtimes?color=blue&label=version" alt="Version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" /></a>
</p>

`agent-runtimes` 是一个 Node.js/TypeScript 兼容层，通过统一的 `Runtime → Session → Run → RuntimeEvent` API，把本地 Agent CLI 的发现、启动、控制与观测方式统一起来。

> [!WARNING]  
> agent-runtimes 目前为早期技术预览，推荐使用 Windows 和 Linux 平台以获得更好的使用体验。macOS 的支持仍在持续优化中，在此之前它们的适配性和稳定性可能略低于 Windows 和 Linux。

开发者文档：[文档](./docs/dev/READDEVDOC_CN.md)

## 支持的 runtime

| ID                                                                                                                 | 会话续接                    | 实时模型       | 认证探测                  | MCP 发现         |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------- | ------------------------- | ---------------- |
| <img src="./docs/for_README/icon/opencode.png" height="32" align="middle" alt="OpenCode" /> `opencode`             | `-s`（capture 式）          | `models`       | `auth list` + `auth.json` | `mcp list`       |
| <img src="./docs/for_README/icon/opencode.png" height="32" align="middle" alt="OpenCode via ACP" /> `opencode-acp` | `session/load`              | —              | —                         | 经 `session/new` |
| <img src="./docs/for_README/icon/claudecode-color.png" height="32" align="middle" alt="Claude Code" /> `claude`    | `--resume`（capture 式）    | 静态别名¹      | `login status`            | `mcp list`       |
| <img src="./docs/for_README/icon/codex-color.png" height="32" align="middle" alt="Codex" /> `codex`                | `exec resume`（capture 式） | `debug models` | `login status`            | `mcp list`       |

¹ Claude Code 没有 list-models 子命令，因此 `sonnet` / `opus` / `haiku`（+ `claude-*-5-*` 全名）为手工维护的静态表。

四个 runtime 都提供只读发现接口——`models()`、`auth()`、`mcp()`、`skills()`、`plugins()`——只给元数据，从不给文件内容。拿不到就报 `"unknown"` / `[]`，绝不用过期静态表冒充。

## 安装

要求 `Node.js >= 20`。

```bash
npm i @stratosphereslab/agent-runtimes
```

```bash
pnpm add @stratosphereslab/agent-runtimes
```

或从源码构建：

```bash
git clone <this-repo> && cd agent-runtimes
pnpm install && pnpm build
```

## 用法

```ts
import { runtimes } from "@stratosphereslab/agent-runtimes";

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

## 输入控制

```ts
const runtime = await runtimes.resolve("claude");
const session = await runtime.createSession({
  cwd: "./my-project",
  model: "sonnet",
  reasoning: { effort: "high" },
  agent: "build", // 仅 opencode/claude——先查 capabilities()
  workspace: { allowedPaths: ["./shared"], permissionMode: "plan" },
  allowedTools: ["Read"], // claude --allowedTools
  onPermissionRequest: async (req) => ({ optionId: "allow" }),
});

// 纯文本或结构化 parts（text/image 混排）：
const run = await session.run(
  [
    { type: "text", text: "这是什么？" },
    { type: "image", path: "./shot.png" },
  ],
  { model: "haiku" }, // 单轮覆盖
);
for await (const event of run.events()) {
  if (event.type === "permission_request") console.log("agent 提问：", event.prompt);
  else if (event.type === "permission_denied") console.log("被拦：", event.reason);
  else if (event.type === "done") break;
}
// 运行中追问（仅 ACP）：await run.send("其实用 pnpm");
await session.close();
```

规则：每个 runtime 通过 `runtime.capabilities()` 声明自己支持什么（`agentSelection`、`toolAllowlist`、`systemPrompt`……）——不支持的输入在 `createSession` 直接报错，绝不悄悄吞掉。没有原生会话 id 就续不上历史；用 `foldSeedMessages()` 把旧轮次折成文本拼在前面。前端透传契约（`WireSendInput`、NDJSON 分帧）：`docs/frontend.md`。

## 聊天 UI（assistant-ui）

如果你的前端基于 [assistant-ui](https://www.assistant-ui.com)，事件→消息的映射随包一起发布，不用每个项目重写一遍 fold：

```ts
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

```tsx
const store = createThreadStore({
  transport: createRuntimeTransport({
    endpoints: {
      turn: "/api/agent/turn",
      cancel: "/api/agent/cancel",
      permission: "/api/agent/permission",
    },
  }),
});
const runtime = useExternalStoreRuntime(createExternalStoreAdapter(store));
```

流式文本、思考过程、工具调用、可交互的 Allow/Deny 审批门、取消、用量/花费，
以及一条承载结构化卡片的 `data-*` 通道——全部来自同一条 `RuntimeEvent` 流。
务必从 `/assistant-ui` 子路径导入——包根是 Node 专用的。见
`docs/frontend-assistant-ui.zh-CN.md`。

## CLI

检查某个 runtime 的健康状况——能跑则退出码 `0`，阻塞性失败 `1`，用法错误 `2`：

```bash
# 免安装——直接跑 registry 上的已发布 bin
npx --package @stratosphereslab/agent-runtimes agent-runtimes -d opencode

# 已安装的 bin（npm i -g @stratosphereslab/agent-runtimes）
agent-runtimes -d opencode
agent-runtimes -d claude
agent-runtimes -d codex

# 不带 id：一次性检查所有已注册 runtime
agent-runtimes -d

# 给 setup 向导用的机器可读报告，以及 bin 自身版本
agent-runtimes -d --json
agent-runtimes --version

# 有新版？stderr 上一行提醒（绝不自动装，--json 保持干净，退出码不变）

# 本地构建——同一条路，长写法（从源码永远可用）
node dist/cli.js doctor opencode
```

输出示例：

```
Executable   ✓  C:\...\npm\node_modules\opencode-ai\bin\opencode.exe
Version      ✓  1.18.32
Model        ✓  182 model(s) across 3 providers: deepseek, nvidia, opencode
MCP          ✓  2 server(s): github, firecrawl
```

`agent-runtimes -h` 打印用法；`doctor <id>` 两种形态下都有效。

## 功能

- **发现** —— PATH + 别名 + `*_BIN` 覆盖 + 已知安装位置；选最新可调用版本；跳过坏 shim。`findAllInstalls()` 列出每个安装（包管理器、版本、是否选中）；按系统识别，外系统 shim 不掺和。
- **会话** —— create / run / resume / cancel / close；原生 id 从事件流捕获并落盘（`~/.agent-runtimes/sessions`，Electron 可用 `setSessionStoreDir` 改位置）。
- **历史** —— 只读会话历史（`session.history()`），从各 CLI 原生转录库折叠而来；压缩条目、`limit`/`since` 分页、失败放空、库内绝不落盘。
- **事件** —— 只暴露与具体 Agent 无关、可 JSON 序列化的 `RuntimeEvent`：`session_started | text_delta | reasoning_delta | tool_started | tool_finished | usage | permission_request | permission_denied | error | done`。从不泄露 stdout/stderr/JSONL。每个事件带可选 `runId`；思考过程是纯展示的 `reasoning_delta`，空思考静默丢弃、不报错。
- **模型 / 认证 / MCP** —— 每个 runtime 实时发现（`models()`、`auth()`、`mcp()`）；拿不到就报 `"unknown"`，绝不用过期静态表冒充。显式模型在创建会话时校验（`isKnownModel`——拼错在 spawn 之前就被拒）；opencode `--variant` 只发真实存在的档位。
- **技能 / 插件** —— 只读元数据发现（`skills()`、`plugins()`）：全局 + 项目根目录、marketplace id、版本、启用状态。从不读文件内容。
- **版本与诊断** —— 每个 adapter 的 CLI 版本策略（`untested-version` 警告）；`doctor` 每行带机器可读的 `reason` 码（`not-on-path`、`shim-broken`、`auth-missing`……），直接显示。registry 有新版时 Version 行追加 `→ 最新版`（`update-available`）。
- **按能力分支，不按名字** —— 检查 `runtime.capabilities().sessionResume`，不要写 `runtime.id === "claude"`。
- **护栏** —— 图片（路径优先）、工作区 allowlist / 沙箱 / permission-mode 门控、prompt 长度预算、交互式权限请求（`AskUserQuestion` / ACP）、日志与错误详情不含密钥。

## 反馈问题

发现 bug？去 [issues](https://github.com/StratoSpheres-Labs/agent-runtimes/issues) 提交，带上：

- `agent-runtimes -d <id>` 的输出（或 `-d --json` 机器可读报告）和 `agent-runtimes --version`
- 操作系统、Node 版本（`node --version`）、agent CLI 版本
- 最小复现：触发它的 prompt/会话选项、预期 vs 实际、退出码
- 出错 `doctor` 行上的 `reason` 码（如果有，`not-on-path`、`shim-broken`……）——它直接告诉我们去哪看

提交前先看 `docs/PARITY.md`：deferred 的是明确不做的，不是 bug。也绝不要贴密钥——粘贴过的凭证可能回显在转录里；分享日志时保持 `history()` 输出的脱敏状态。

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
- `docs/frontend-assistant-ui.zh-CN.md` —— 随包发布的 [assistant-ui](https://www.assistant-ui.com) 适配层：`RuntimeEvent` → 聊天 part、审批门、`data-*` 卡片。
- `docs/runtime-authoring.md` —— 如何新增 `runtimes/<id>/` 作为架构压力测试。
- `AGENTS.md` —— 仓库约定、目录结构、测试要求。

## 项目结构

```
src/core/         # runtime、session、run、registry、lifecycle、session-store —— 与具体 Agent 无关
src/definition/   # identity、executable、input、transport、session、capability、model、mcp、auth ……
src/events/       # RuntimeEvent、EventStream
src/transport/    # RuntimeTransport + StdioTransport + AcpTransport
src/parser/       # RuntimeParser + JSONL 实现（半包安全）
src/frontend/     # 浏览器安全的聊天 UI 适配层（assistant-ui）——独立子路径，零 node 依赖
src/discovery/    # executable / version / models / mcp / auth 探测
src/doctor.ts     # doctor 报告 + summarizeModels
src/cli.ts        # agent-runtimes [-d|--doctor] <id>（doctor <id> 同样有效）
runtimes/opencode/ | claude/ | codex/ | opencode-acp/  # definition、parser、runtime、session、fixtures
tests/  examples/basic.ts  docs/
```

## 许可证

Apache-2.0 —— 见 [LICENSE](./LICENSE)。
