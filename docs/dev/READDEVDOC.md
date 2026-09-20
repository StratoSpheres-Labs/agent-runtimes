# agent-runtimes Developer Docs

[English](./READDEVDOC.md) | [中文](./READDEVDOC_CN.md)

One unified API over local AI coding CLIs: discover, spawn, control, and
observe them through `Runtime → Session → Run → RuntimeEvent`.

## Contents

| Section         | Pages                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting started | [Overview](./getting-started/overview.md) · [101](./getting-started/101.md) · [Install](./getting-started/install.md) · [Quickstart](./getting-started/quickstart.md)                                                                                                |
| Core concepts   | [Core model](./concepts/core-model.md) · [Events](./concepts/events.md) · [Capabilities](./concepts/capabilities.md) · [Rules](./concepts/rules.md)                                                                                                                  |
| Discovery       | [Installs](./discovery/installs.md) · [Models & auth](./discovery/models-auth.md) · [MCP, skills, plugins](./discovery/media-skills.md) · [Updates](./discovery/updates.md) · [Doctor](./discovery/doctor.md)                                                        |
| Running         | [Sessions](./running/sessions.md) · [Streaming](./running/runs-streaming.md) · [Lifecycle](./running/lifecycle.md) · [Workspace](./running/workspace.md) · [Permissions](./running/permissions.md) · [Images](./running/images.md) · [History](./running/history.md) |
| Guides          | [Frontend wire](./guides/frontend-wire.md) · [Cross-platform](./guides/cross-platform.md) · [Multi-agent](./guides/multi-agent.md) · [New runtime](./guides/new-runtime.md)                                                                                          |
| Resources       | [Errors](./resources/errors.md) · [CLI](./resources/cli.md) · [FAQ](./resources/faq.md)                                                                                                                                                                              |

## Map

- `getting-started/` — install, first run.
- `concepts/` — the mental model (read once, then link back).
- `discovery/` — read-only inspection: installs, models, auth, MCP, skills, plugins, updates, doctor.
- `running/` — doing work: sessions, streaming, lifecycle, workspace, permissions, images, history.
- `guides/` — frontend wire contract, cross-platform, multi-agent workspaces, authoring a runtime.
- `resources/` — error codes, CLI reference, FAQ.
- `llms.txt` — machine-readable index of every page (for AI consumers).

Deep dives live one level up in `docs/`: `architecture.md` (the model +
seven rules), `development.md` (setup, test tiers), `frontend.md` (wire
contract), `runtime-authoring.md` (new adapters), `cross-platform.md`.
