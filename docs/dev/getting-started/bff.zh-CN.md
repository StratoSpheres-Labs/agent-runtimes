# BFF Cookbook（后端/前端接入指南）

用最薄的一层把前端（或后端服务）接到 `agent-runtimes`。这里讲**做法**；
**契约**在 [frontend.md](../../frontend.md)（事件形状、错误码、分帧）。

```
Agent CLI → Transport → Parser → BFF（Node，持有 Session/Run）→ SSE → UI（只见 JSON）
```

## 规则 0：浏览器永远不 import 这个库

库会 spawn 子进程（`node:child_process`、`node:fs`），只能跑在
Node ≥ 20——BFF、daemon 或 Electron **主进程**。渲染进程只见 JSON：
后端用 `encodeRuntimeEvent` 一行一个事件往外写，前端用
`decodeRuntimeEventLine` 解析。最多 `import type` 拿类型。

## 后端：五件事

1. **NDJSON 当 SSE 发。** `GET /events` 调 `session.run(prompt)`，
   每个事件写成 `data: <encodeRuntimeEvent(event)>`。一行一事件——
   前端按 `\n` 切行，不用自己拼半包 JSON。
2. **一个 session 一次只跑一个 run。** 流式中再调 `run()` 会抛
   `RuntimeSessionError`。回 409（"先 drain 到 done"），别静默排队。
   Run N 必须 drain 到 `done` 再开 run N+1，否则 resume 会静默开一个
   全新的上游会话，上下文全丢。
3. **cancel 一定以 `done` 收尾。** `run.cancel()` /
   `session.cancel()` 会推一个带 kill signal 的终端 `done`——"取消了"
   和"流断了"能区分开。光 `close()` 是静默 teardown，什么都不发。
4. **权限留在后端。** `onPermissionRequest` 是函数，过不了 wire
   （`WireCreateSessionOptions` 把它 omit 掉了）。`permission_request`
   事件只管往下游转发展示，用 `run.respondToPermission(id, optionId)`
   回答。`permission_denied` 是 observe-only，没什么可答的。
5. **按 `error.code` 切，永不匹配 message。** message 是给人看的文案，
   随时会变；14 个错误码（`TIMEOUT`、`STALL`、`NON_ZERO_EXIT`……）
   才是给机器的。未知 `runId`、已结束的 run、不支持的 `send()` 都会
   大声拒绝——抛给 UI，别静默重试。

## 前端：四件事

1. **按 `runId` 分组。** 每个事件都带 `<sessionId>:run<N>`，交织的多
   会话流靠它拼回一轮。
2. **按 discriminant 渲染。** `text_delta` 追加，`reasoning_delta`
   折叠（置灰/收起——纯展示，不可当 resume 输入），
   `tool_started`/`tool_finished` 行内展示，`done` 收尾。
3. **被拦了要展示出来，不要静默。** `permission_denied` 用 `id` 和同
   一次调用的 `tool_started`/`tool_finished` 对上——显示"Write 被拦：
   需要手动批准"，而不是一片空白。
4. **未知类型 fail-open。** 事件集合只增不减；未知 discriminant 用
   通用行展示，别抛错。

## SSE 之外

同一批事件，换个分帧（`frontend.md` §Framing）：

| 通道          | 映射方式                        |
| ------------- | ------------------------------- |
| WebSocket     | 一行 NDJSON 一条文本消息        |
| Electron IPC  | 解析后事件的 `structuredClone`  |
| 上行 steering | `WireSendInput { runId, text }` |

`run.send()` 需要 `allowMidRunInput` + `midRunInput` runtime（只有
ACP 行；stdio 系 CLI 会拒绝）。纯文本，图片留后端。

## 跑起来

```bash
pnpm example:bff
# 打开 http://localhost:3000，输入一句话，看流
# RUNTIME_ID=claude pnpm example:bff   # 换个 CLI
```

Demo（`examples/bff-sse.ts`，只用 `node:http`，零依赖）就是完整切片：
演示页、SSE 单轮接口、`/send` steering、`/permission` 审批应答、`/cancel`。
拷走后先删演示页——你的 UI 替换的就是那部分，其余保留。

它的兄弟 `examples/bff-assistant-ui.ts` 是给
[assistant-ui](../assistant-ui.zh-CN.md) 适配层用的同一片切片：把
`GET /events` 换成 `POST /turn`，加上 `/permission`，并把
`dist/assistant-ui.js` 一并 serve，让页面能直接 import 那个 bundle。
它的路由由 `tests/bff-assistant-ui.test.ts` 用桩 session 覆盖，
所以不是又一个只能手动跑的东西。

## 从真实聊天 UI 用起来

上面四条路由加上事件流就是全部契约。如果你用适配层，请选
`examples/bff-assistant-ui.ts`（`pnpm example:bff-ui`）——适配层是把
`{ prompt, session }` POST 到 `/turn`，而 `bff-sse.ts` 走的是
`EventSource` 的 `GET /events?prompt=…`。如果你的 UI 基于
[assistant-ui](https://www.assistant-ui.com)，
就不必自己写事件→消息的映射：

```ts
import {
  createRuntimeTransport,
  createThreadStore,
  createExternalStoreAdapter,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

cookbook 见 [assistant-ui.zh-CN.md](./assistant-ui.zh-CN.md)，契约见
[frontend-assistant-ui.zh-CN.md](../../frontend-assistant-ui.zh-CN.md)。

## 这里不做什么

鉴权、持久化、多用户会话、往库里 ship HTTP server——那是你 app 的活，
不是这层的。`session.history()` 是 read-through 且默认脱敏；别打日志，
没经同意别往外传。

## 下一步

- [前端契约](../../frontend.md)——全部事件类型、错误码、queue、版本规则。
- [assistant-ui cookbook](./assistant-ui.zh-CN.md)——React 聊天 UI 的接线配方。
- [Quickstart](./quickstart.md)——这个切片包起来的 library 直连流程。
