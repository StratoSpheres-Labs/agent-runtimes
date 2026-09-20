# agent-runtimes 开发者文档

[English](./READDEVDOC.md) | [中文](./READDEVDOC_CN.md)

一套统一 API，管本地 AI 编程 CLI 的发现、启动、控制与观测：`Runtime → Session → Run → RuntimeEvent`。

## 目录

| 分区     | 页面                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入门     | [概览](./getting-started/overview.zh-CN.md) · [101](./getting-started/101.zh-CN.md) · [安装](./getting-started/install.zh-CN.md) · [快速上手](./getting-started/quickstart.zh-CN.md)                                                      |
| 核心概念 | [核心模型](./concepts/core-model.md) · [事件](./concepts/events.md) · [能力](./concepts/capabilities.md) · [规则](./concepts/rules.md)                                                                                                    |
| 发现     | [安装](./discovery/installs.md) · [模型与认证](./discovery/models-auth.md) · [MCP、技能、插件](./discovery/media-skills.md) · [更新](./discovery/updates.md) · [体检](./discovery/doctor.md)                                              |
| 运行     | [会话](./running/sessions.md) · [流](./running/runs-streaming.md) · [生命周期](./running/lifecycle.md) · [工作区](./running/workspace.md) · [权限](./running/permissions.md) · [图片](./running/images.md) · [历史](./running/history.md) |
| 指南     | [前端传输](./guides/frontend-wire.md) · [跨平台](./guides/cross-platform.md) · [多 agent](./guides/multi-agent.md) · [新 runtime](./guides/new-runtime.md)                                                                                |
| 资源     | [错误](./resources/errors.md) · [CLI](./resources/cli.md) · [FAQ](./resources/faq.md)                                                                                                                                                     |

## 地图

- `getting-started/` —— 安装、首跑。
- `concepts/` —— 心智模型（读一遍，后面只引用）。
- `discovery/` —— 只读检查：安装、模型、认证、MCP、技能、插件、更新、体检。
- `running/` —— 干活：会话、流、生命周期、工作区、权限、图片、历史。
- `guides/` —— 前端传输约定、跨平台、多 agent 工作区、写新 adapter。
- `resources/` —— 错误码、CLI 参考、FAQ。
- `llms.txt` —— 机器可读的页面索引（给 AI 消费者）。
