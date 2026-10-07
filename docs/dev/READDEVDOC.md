# agent-runtimes Developer Docs

[English](./READDEVDOC.md) | [中文](./READDEVDOC_CN.md)

One unified API over local AI coding CLIs: discover, spawn, control, and
observe them through `Runtime → Session → Run → RuntimeEvent`.

## Contents

| Section         | Pages                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting started | [Overview](./getting-started/overview.md) · [101](./getting-started/101.md) · [Install](./getting-started/install.md) · [Quickstart](./getting-started/quickstart.md) · [BFF](./getting-started/bff.md) · [assistant-ui](./getting-started/assistant-ui.md) · [Modes](./getting-started/modes.md) |
| Architecture    | [architecture.md](../architecture.md) (model + seven rules) · [development.md](../development.md) (setup, test tiers, release)                                                                                                                                                                    |
| Contracts       | [frontend.md](../frontend.md) (wire contract + error codes) · [frontend-assistant-ui.md](../frontend-assistant-ui.md) (chat-UI adapter) · [runtime-authoring.md](../runtime-authoring.md) (new adapters) · [cross-platform.md](../cross-platform.md)                                              |

## Map

- `getting-started/` — install, first run, the BFF slice, the assistant-ui cookbook (the only pages under `docs/dev/`).
- `../` (repo-root `docs/`) — the deep dives: architecture, development, frontend wire contract, the assistant-ui adapter, runtime authoring, cross-platform.
- `llms.txt` — machine-readable index of every page (for AI consumers).

Deep dives live one level up in `docs/`: `architecture.md` (the model +
seven rules), `development.md` (setup, test tiers), `frontend.md` (wire
contract), `frontend-assistant-ui.md` (the shipped chat-UI adapter),
`runtime-authoring.md` (new adapters), `cross-platform.md`.
