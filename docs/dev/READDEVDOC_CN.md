# agent-runtimes 开发者文档

[English](./READDEVDOC.md) | [中文](./READDEVDOC_CN.md)

一套统一 API，管本地 AI 编程 CLI 的发现、启动、控制与观测：`Runtime → Session → Run → RuntimeEvent`。

## 目录

| 分区 | 页面                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入门 | [概览](./getting-started/overview.zh-CN.md) · [101](./getting-started/101.zh-CN.md) · [安装](./getting-started/install.zh-CN.md) · [快速上手](./getting-started/quickstart.zh-CN.md) · [BFF](./getting-started/bff.zh-CN.md) |
| 架构 | [architecture.md](../architecture.md)（模型 + 七条硬规则）· [development.zh-CN.md](../development.zh-CN.md)（环境、测试分层、发版）                                                                                          |
| 约定 | [frontend.md](../frontend.md)（传输约定 + 错误码）· [runtime-authoring.md](../runtime-authoring.md)（新 adapter）· [cross-platform.md](../cross-platform.md)                                                                 |

## 地图

- `getting-started/` —— 安装、首跑（`docs/dev/` 下仅有的页面）。
- 上层 `docs/` —— 深水区：架构、开发、前端传输约定、写新 adapter、跨平台。
- `llms.txt` —— 机器可读的页面索引（给 AI 消费者）。
