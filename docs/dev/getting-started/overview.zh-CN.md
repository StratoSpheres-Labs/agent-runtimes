# 概览

`agent-runtimes` 是本地 AI 编程 CLI（OpenCode、Claude Code、Codex）之上的
Node.js/TypeScript 兼容层。每个 agent 方言都不同——argv 形状、stdin 格式、
JSONL 事件种类、续接 flag——这个库把它们藏到同一套 API 后面：

```
Runtime → Session → Run → RuntimeEvent
```

| 步骤       | 调用                             | 得到                                 |
| ---------- | -------------------------------- | ------------------------------------ |
| 选 agent   | `runtimes.resolve("opencode")`   | `Runtime`——每个 CLI 同一形状         |
| 检查在不在 | `runtime.detect()`               | `{ installed, executable, version }` |
| 开工作区   | `runtime.createSession({ cwd })` | 横跨多个进程的 `Session`             |
| 跑一轮     | `session.run(prompt)`            | 带 `RuntimeEvent` 异步流的 `Run`     |

## 它不是什么

- 不是 LLM 客户端——从不调模型 API，只拉起你装好的 CLI。
- 不是 planner、工具执行器、记忆或 UI——那些属于上层（daemon 或应用）。
- 不是配置管理器——从不写 CLI 配置、不碰凭证。只读发现，只管拉起。

## 下一步

- [101](./101.zh-CN.md)——方言为什么不同、归一了什么。
- [安装](./install.zh-CN.md)——从源码构建。
- [快速上手](./quickstart.zh-CN.md)——5 分钟首跑。
