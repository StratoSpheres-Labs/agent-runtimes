# 快速上手

五分钟，跑通一轮 agent 对话。假设[安装](./install.zh-CN.md)已完成，PATH 上至少有一个 CLI。

## 1. 探测

```ts
import { runtimes } from "agent-runtimes";

const runtime = await runtimes.resolve("opencode"); // 或 "claude" / "codex"
const status = await runtime.detect();
if (!status.installed) throw new Error("agent CLI not found");
console.log(status.executable, status.version);
```

## 2. 跑一轮

```ts
const session = await runtime.createSession({ cwd: "./my-project" });
const run = await session.run("Reply with exactly: pinecone");

for await (const event of run.events()) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else if (event.type === "tool_started") console.log(`[tool] ${event.name}`);
  else if (event.type === "done") break;
}
await session.close();
```

典型输出——三个事件，每个都带 run 归属：

```json
{"type":"session_started","sessionId":"ses_f47…","runId":"sess_mu8…:run1"}
{"type":"text_delta","text":"pinecone","runId":"sess_mu8…:run1"}
{"type":"done","exitCode":0,"runId":"sess_mu8…:run1"}
```

## 3. 你刚刚依赖的三条规则

- 一个会话同时只跑一个 run——前一个没完就调第二个会抛错，绝不悄悄取消。
- `run.cancel()` 以终态 `done` 收尾；光 `close()` 是静默收尾。
- 思考过程走 `reasoning_delta`，绝不混进 `text_delta`。

## 失败时

- `RuntimeNotFoundError`——`resolve()` 的 id 写错了；合法值：
  `opencode`、`opencode-acp`、`claude`、`codex`。
- 进程非零退出——先收到 `error` 事件，再收到 `done`。信息里带原因，不带密钥。
- 完整错误目录见[资源](../resources/errors.md)。

## 下一步

- [核心模型](../concepts/core-model.md)——Runtime/Session/Run 到底是什么。
- [流式消费](../running/runs-streaming.md)——全部事件类型、权限、用量。
