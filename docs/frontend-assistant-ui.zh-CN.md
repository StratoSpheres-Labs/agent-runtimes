# assistant-ui 接入

用 [assistant-ui](https://www.assistant-ui.com) 把 `agent-runtimes` 接进 React
聊天界面。配套 [frontend.md](./frontend.md) —— 那一页定义线路契约（事件形状、
错误码、分帧），这一页定义实现它的适配层，省得每个项目重写一遍同样的 fold。

它以**独立的浏览器安全入口**发布：

```ts
import {
  createThreadStore,
  createExternalStoreAdapter,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

> **只能从子路径导入，绝不能从包根导入。** `src/index.ts` 会引入
> `node:child_process`；打包器为 renderer 解析根入口时，会在第一个 `node:`
> 说明符上失败。子路径单独构建（`platform: "browser"`、`target: "es2022"`），
> 而且 `dist/assistant-ui.js` 的**导入数为零** —— 没有内置模块，没有运行时依赖。
> 有一个测试会走导入图，一旦这条性质被破坏就让构建失败。

## 分层

```
Agent CLI → Transport → Parser → BFF (Session/Run) → SSE → stream.ts
                                                              ↓
                                                         fold.ts  RuntimeEvent → parts + status
                                                              ↓
                                    ThreadStore / ChatModelAdapter → assistant-ui runtime hook
```

| 模块                | 职责                                              |
| ------------------- | ------------------------------------------------- |
| `types.ts`          | assistant-ui 形状的本地结构化镜像（构建时被擦除） |
| `fold.ts`           | reducer：`RuntimeEvent` → 累积 parts + 消息状态   |
| `stream.ts`         | SSE / NDJSON → `RuntimeEvent[]`                   |
| `transport.ts`      | `fetch` 封装：起 turn、取消、批准、steer          |
| `chat-model.ts`     | 给 `useLocalRuntime` 的 `ChatModelAdapter`        |
| `external-store.ts` | 给 `useExternalStoreRuntime` 的 store + adapter   |

`fold.ts` 之上的一切都是薄壳。所以 fold 放在这里而不是某个 runtime adapter
里：它是 agent 无关的（规则 6），也不认识进程（规则 4）。

## 选哪个 runtime hook

| Hook                      | 什么时候用                                        | 入口                                               |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `useExternalStoreRuntime` | 需要审批、服务端中断 —— **编码 agent 的默认选择** | `createThreadStore` + `createExternalStoreAdapter` |
| `useLocalRuntime`         | 希望消息状态由 assistant-ui 托管，后端不参与      | `createChatModelAdapter`                           |

给本地 agent CLI 推荐 external-store 那条路，因为它的两个功能是**真实的服务端
调用**，不是客户端状态：

- `permission_request` → `onRespondToToolApproval` 会回传到
  `run.respondToPermission`，Allow / Deny 真的会放行 agent；
- `onCancel` 是服务端中断，流以终态 `done` 结束。

两种 runtime 目前都**无法诚实支持**编辑 / 重新生成 / 分支 —— 接线之前请先读
[不支持的部分](#不支持的部分编辑--重新生成--分支)。

## 事件 → assistant-ui 映射

| `RuntimeEvent`       | 结果                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `session_started`    | `nativeSessionId` → `metadata.custom`（续接句柄）；不产生可见 part                         |
| `text_delta`         | 追加到末尾的 text part                                                                     |
| `reasoning_delta`    | 追加到末尾的 reasoning part                                                                |
| `tool_started`       | `tool-call` part：`toolCallId`、`toolName`、`args`、`argsText`；无 `result` → 显示为运行中 |
| `tool_finished`      | 填入 `result` / `isError`；同时结算待决的审批门                                            |
| `permission_request` | 在该 tool part 上打 `approval: { id, prompt, options }` + 消息状态 `requires-action`       |
| `permission_denied`  | `approval.approved = false` + `result: { error, isError: true }` —— 只观察，不等待         |
| `error`              | 消息状态 `incomplete` / `reason: "error"`，携带 `{ code, message }`                        |
| `usage`              | `metadata.steps[].usage`（token）与 `metadata.custom`                                      |
| `done`               | `complete` / `stop`；若本轮被取消则为 `incomplete` / `cancelled`                           |
| 其他                 | 忽略，但**会被记录** —— 见[可观测性](#可观测性适配器到底告诉你什么)                        |

### fold 存在的理由：三条 assistant-ui 硬约束

1. **给快照，绝不给增量。** `ChatModelRunResult.content` 在每次 yield 时被
   **整体替换**，yield 增量会闪烁。`snapshot()` 永远返回完整的累积 part 列表。
2. **只有最后一个 part 才可以是 `running`。** 一个空的尾部 text part 会把
   **前一个** part 标记为完成 —— 所以 `fold.ts` 绝不创建没有内容的 text /
   reasoning part，`emit()` 宁可抛错也不愿污染流。
3. **状态是推导出来的，不是赋值的。** `currentStatus()` 按
   （error、cancelled、待决审批、done）重算，优先级从具体到宽泛，因此 reducer
   不可能和自己已折叠的内容脱节。

### 保留交错顺序

编码 agent 的输出不是"一段文本，然后一些工具"。fold 保持发出顺序，所以
`reasoning → tool → text` 会按该顺序渲染，而不是被压成一坨文本：

```
[reasoning] [tool-call] [text] [tool-call] [text]
```

## 可观测性：适配器到底告诉你什么

下面这些全在 `ThreadStoreSnapshot` 里，以及每条 assistant 消息的 `metadata`
上。核心是一句话：**不允许静默失败** —— 对应的正是聊天 UI 最容易藏起来的那几类
故障（内容被丢弃、"空会话"其实是后端挂了、这一轮永远不收敛）。

### `loadState` —— 会话为什么是空的

```
{ type: "idle" }                              还没发过任何消息
{ type: "loading" }                           这一轮在飞，还没到第一个事件
{ type: "ready" }                             已经有内容了
{ type: "error", error }                      后端拒绝了 / 连不上
```

没有这个，"你还没有消息"、"第一轮正在启动" 和 "BFF 挂了" 会渲染成同一个空会话。

### `runState` —— `cancelling` 不是 `streaming`

```
{ type: "idle" } | { type: "streaming" } | { type: "cancelling" } | { type: "error", error }
```

用户按 Stop 之后，agent 在收到终止 `done` 之前**仍在持续产出事件**。整个这段
窗口都报"生成中"是错的，所以 cancelling 是独立状态。两种状态下 `isRunning` 都保持
true（assistant-ui 需要它来留住 Stop 按钮）。

### `unhandledEvents` —— 我们没能投影的内容

```ts
// fold 层（直接调库的场景）：snapshot.unhandledEvents
// wire 层（新版 CLI 发来未知类型）：transport 的 onProtocolError
transport: createRuntimeTransport({
  endpoints: { turn: "/turn" },
  onProtocolError: (err) => console.warn("丢了一行:", err.message),
});
```

wire 层的精确行为：一行解不开（JSON 损坏，或本版本不认识的事件类型）会被
**跳过，流继续** —— fail open 正是让新版 CLI 能跑在旧适配器上的前提。坏行前后的
内容都会送达，丢的只有那一行。fold 绝不保存出事的 payload：那是不可信的 wire
数据，可能回显 prompt 片段，所以只留类型名和计数。

> 解码器过去会**在 chunk 中途抛错**，把同一 chunk 里已经解开的事件全部丢掉 ——
> 而一次 read 就可能装下整轮对话，于是一行坏数据能换走用户真实读到的文本。
> 已修复，并由 `tests/assistant-ui-stream.test.ts` 钉住。

### `droppedParts` 与 `metadata.timing`

`droppedParts` 非零表示触到了 `MAX_TURN_PARTS` 上限、发生过驱逐 —— 屏幕上的
转录是不完整的，UI 应该说出来。
`metadata.timing` 是可以直接喂给 assistant-ui `MessageTiming` 的成品
（`streamStartTime`、`firstTokenTime`、`totalStreamTime`、`tokenCount`、
`tokensPerSecond`、`totalChunks`、`toolCallCount`），全部来自 fold 本来就有的
数据。注意单位：`streamStartTime` 是 epoch，另两个是以毫秒计的**时长**。

## `data-*` 扩展通道

assistant-ui 的 part 联合类型留了一条开放通道给结构化卡片。上游存在两种写法，
哪一种合法取决于用哪个 runtime：

| Part                                     | 适用于                                           |
| ---------------------------------------- | ------------------------------------------------ |
| `{ type: "data-<name>", data }`          | `useExternalStoreRuntime`（`ThreadMessageLike`） |
| `{ type: "data", name: "<name>", data }` | `useLocalRuntime`（`ChatModelRunResult`）        |

`AssistantTurn.emit` / `ThreadStore.emit` 两种都收；chat-model 适配器在输出时
把前缀形式改写成带 `name` 的形式，因为 local-runtime 的联合类型没有别的写法。

```ts
store.emit({ type: "data-spec-sheet", data: { title: "Q3", rows: rows.length } });
```

这是 agent 产出的非文本内容（报告、spec sheet、来源、检索片段、打分结论）的
正式归宿。它是一条**前端侧**通道 —— 没有新增任何 `RuntimeEvent`，`src/core`
原封不动。

## 工具参数

assistant-ui 把 `args` 定型为 JSON **对象**，而 `tool_started.input` 是
`JsonValue`（可能是字符串或数组）。对象原样透传；其他类型包进稳定的 `value`
键，原始 JSON 始终保留在 `argsText` 里（上游要求这个字段，而且它正好也是
渲染器流式参数的文本）。

## 不支持：嵌套的子 agent 对话

`history()` 可以把子 agent 的转录嵌套在派发它的那次工具调用下
（`HistoryOptions.includeSubAgents`，由 `RuntimeCapabilities.subAgents` 把关；
目前只有 opencode 支持 —— 见 [`PARITY.md` §4](./PARITY.md)）。assistant-ui
适配器**还没有**把它们折叠进 `ToolCallMessagePart.messages`，所以子 agent 的
对话不会出现在派生它的那张工具卡片里。

缺两样东西，按顺序：

1. **一条 BFF history 路由。** transport 的四条路由只覆盖一次 turn，没有任何
   东西能把转录读回来。
2. **折叠逻辑。** 把转录条目嵌进 `messages` 需要和顶层投影一样的谨慎：子 agent
   的工具调用**不属于**父 run，所以不能继承父 run 的 `runId`、审批门或
   `status`。这里错了，就会出现一个"允许"按钮，而那个 run 从来没有为它发出过
   `permission_request`。

在两者落地之前，别在宿主里自己手搓：真正容易搞错、又不可能被消费者发现的那部分，
是关联规则（**关联不上的子 agent 要丢掉，而不是猜一个父调用**）。

## 权限：审批门

`permission_request` 会变成 tool part 上一个待决的 `approval`，消息状态翻成
`requires-action` —— 这正是 assistant-ui 在工具卡片上渲染 Allow / Deny 所需的
东西（`ToolFallback` 开箱即用）。

- `options[].optionId` → `approval.options[].id`
- `options[].kind` 归一到 assistant-ui 的连字符集合（`allow_once` →
  `allow-once`）；未知 kind 原样透传（该联合类型是开放的）
- **空** options 列表会完全省略 `options` 字段，让 assistant-ui 渲染它的
  Allow / Deny 对，而不是一个点不动的空列表
- 点击经由 `onRespondToToolApproval({ approvalId, approved, optionId })` 回传
  → `transport.respondToPermission(id, optionId)` → `WireRespondPermission`
  → 后端的 `run.respondToPermission(id, optionId)`

`optionId` 绝不由客户端臆造：必须是该事件提供过的之一。

拒绝会把审批门结算为 `approved: false` 并合成一个错误结果，让卡片显示"已阻止"
而不是静默失败。`ThreadStore` 在 turn 排空后**仍然保留**它的 fold，正是为了
让 `done` 之后才到达的点击依然能更新卡片。若应答送不出去，审批门会被**重新
打开**（`reopenApproval`）并把错误继续抛出 —— 绝不会出现"卡片显示已允许、
agent 其实还在等待"的状态。

`permission_denied` 无需应答 —— harness 已经决定了。它渲染为拒绝，绝不是审批门。

### UI 应答必须带的 `id`，以及它在哪里断掉

`WireRespondPermission.id` 必须是 UI 看到的那个 `permission_request.id`，且后端
必须能解析它。这个关联**只在传输层提供 request id 时存在**：

| runtime             | 产 `permission_request` 事件？ | 有 `PermissionRequest.id`？                                                        | UI 往返？                         |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------- |
| `claude`            | 是（`AskUserQuestion`）        | 有（就是 `tool_use_id`）                                                           | **可以**                          |
| `opencode-acp`      | 否                             | 否 —— `session/request_permission` 没有 id，且 `AcpRun` 没有 `respondToPermission` | **不行** —— 只能在 handler 内应答 |
| `opencode`、`codex` | 否                             | —                                                                                  | 不行                              |

所以审批门目前是**只有 claude 支持**的功能。两个 example 对 ACP 都选择
内联应答（并打一条 `console.warn`），而不是臆造一个永远对不上的 key。无法关联的
后端必须响亮拒绝 —— 臆造的 key 每次点击都会 404，这正是这张表要防的 bug。

## 不支持的部分：编辑、重新生成、分支

adapter **没有** `onEdit`、`onReload`、`onResume`，而 assistant-ui 把"回调缺席"
读作"这个应用不支持" —— 所以编辑按钮和重新生成按钮不会出现。这是有意的：接线
反而是撒谎，因为所有支持 runtime 的 resume 路径都只会**延长**会话，没有任何
flag 能截断前缀（见 `docs/PARITY.md` §4「Truncating a conversation」）。

"编辑后重问"只会把新文本发给一个仍持有旧 transcript 的 agent；"重新生成"则会
追加第二个回答而不是替换第一个。两者在 UI 上都看着正常，但对 agent 的上下文
是错的。

`setMessages` 是接上的（所以自己掌握截断能力的宿主可以驱动分支切换），但 adapter
从不产生替代分支，`BranchPicker` 没有东西可切。

真的需要回退，就开一个新的 `Session` —— store 接受 `sessionId`，换个 key 就是
一个全新的上游会话。

## transport 期望的 BFF 路由

| 路由               | 请求体                  | 用途                            |
| ------------------ | ----------------------- | ------------------------------- |
| `POST /turn`       | `{ prompt, session? }`  | 流式返回本轮（SSE 或 NDJSON）   |
| `POST /cancel`     | `{ session?, runId? }`  | 停止活着的 turn；以 `done` 结束 |
| `POST /permission` | `WireRespondPermission` | 回答待决的 `permission_request` |
| `POST /send`       | `WireSendInput`         | 中途 steering（仅 ACP runtime） |

只有 `turn` 是必需的；其余未配置时抛 `TypeError`，所以配置错误的应用会响亮失败，
而不是静默丢弃该动作。

`examples/bff-assistant-ui.ts` 实现的正是这张表（`pnpm example:bff-ui`，然后打开
http://localhost:3000），`tests/bff-assistant-ui.test.ts` 用桩 session 覆盖了它 ——
不需要装任何 CLI。它还把 `dist/assistant-ui.js` 一并 serve 出去，好让示例页面能把它
当普通 ES module `import`。

> 本文件早先的版本指向 `examples/bff-sse.ts`。那是错的：它走的是
> `EventSource` 的 `GET /events?prompt=…`，而 transport 从不调它。它的 `/send`、
> `/permission`、`/cancel` 三条路由确实对得上，只有 turn 那条不一样。两个 example
> 都有用 —— `bff-sse.ts` 用来读原始 SSE，`bff-assistant-ui.ts` 用来对接适配层。

分帧默认 `"sse"`（每个事件一行 `data: <line>`）。需要裸行时设
`framing: "ndjson"`。注意**一个 `data:` 行就是一个事件**，不是一个 SSE frame ——
严格 SSE 会把整轮吞成一个多行 `data:` 字段，因为 `encodeRuntimeEvent` 是
一行一事件，而 demo 没有写空行 frame 终止符。注释行、`event:`/`id:`/`retry:`
字段以及 `[DONE]` 哨兵全部被忽略。

## 接线

### External store（推荐）

```tsx
"use client";
import { useMemo } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";

export function AgentRuntimeProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(
    () =>
      createThreadStore({
        transport: createRuntimeTransport({
          endpoints: {
            turn: "/api/agent/turn",
            cancel: "/api/agent/cancel",
            permission: "/api/agent/permission",
            send: "/api/agent/send",
          },
          sessionId: "default",
        }),
      }),
    [],
  );
  const runtime = useExternalStoreRuntime(createExternalStoreAdapter(store));
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

`ThreadStore` 与框架无关（`getSnapshot` / `subscribe`），所以不想用
assistant-ui 的转换层时，也可以绑到 zustand 或一个普通 `useState` 上。你会得到：
流式输出、思考过程、工具卡片、审批门、取消、用量/花费，以及 `data-*` 通道。你
刻意**不会**得到的是：编辑 / 重新生成 / 分支（见上）。

### Local runtime

```tsx
const runtime = useLocalRuntime(
  createChatModelAdapter({
    transport: createRuntimeTransport({ endpoints: { turn: "/api/agent/turn" } }),
  }),
);
```

assistant-ui 在这条路上托管消息状态。注意取舍：你会拿到 assistant-ui 自己的输入框
队列和分支*管线*，但由于 `onEdit`/`onReload` 永远不会被一个只会延长、不会截断的
CLI resume 正确应答，请把"重新生成"理解成"在新会话里再问一次"（见
[不支持的部分](#不支持的部分编辑重新生成分支)）。

### 用 session store 做线程列表

`listSessionRecords()`（session store）给出 id / nativeId / cwd / model /
updatedAt —— 足够用一个"首条用户消息"作标题去支撑 `RemoteThreadListAdapter`。
这里没有直接提供：session store 的定位是**续接提示**缓存，所以把它当提示看，
永远不要当事实来源。

## 跨越映射后依然成立的规则

- **一个 session 同时只有一个活跃 run。** 有 turn 在流式输出时，`store.send()`
  抛 `RuntimeSessionError`；后端返回 `409`。先排空到 `done`，否则 resume 会
  静默开启一个全新的上游 session 并丢失上下文（[frontend.md](./frontend.md) §Turns）。
- **取消以 `done` 结束。** 流被切断（网络掉线、组件卸载）会结算为
  `incomplete` / `cancelled`，不会让消息永远卡在 `running`。
- **两条不同的失败通道，两套不同的契约。** `error` **事件**携带 14 个 code 的
  分类（`status.error.code`、`metadata.custom.errorCode`）—— 对它 switch code。
  但**根本没能拿到流**（turn 路由因已有活跃 run 返回 `409`、`500`、网络断开）
  是从 `store.send()` **抛出的** `RuntimeProtocolError` / `RuntimeSessionError`，
  而 `RuntimeError` **没有 `code` 字段** —— 只有 `message` + `context`。
  那里按设计就不存在分类，所以只能按你真正观测得到的东西分支：
  `err instanceof RuntimeSessionError`（已有 turn 在流式输出）对应
  `RuntimeProtocolError`（后端拒绝）。HTTP status 藏在 message 里。不要去
  字符串匹配它；如果你需要机器可读的传输层失败分类，那个分类还不存在。
- **switch `error.code`，绝不 switch `error.message`** —— 对 error _事件_ 而言。
  code 会出现在 `status.error.code` 和 `metadata.custom.errorCode`。
- **错误信封会被截断到 200 字符** —— 后端 body 可能回显 prompt 片段或文件路径。
- **`ThreadStore` 不做 `runId` 过滤。** 每次 `startTurn` 都是独立的 POST，
  所以一条流只可能携带那一轮的事件 —— 但如果你把 store 指向一条**复用**的流，
  请自己用 `createAssistantTurn({ runId })` 建 turn，它会按 run 过滤，同时仍然
  接受没有 `runId` 的事件（旧版 payload）。

## 版本化

两个互相独立的方向，都被保护着：

- `RuntimeEvent` 只会增加判别式，而未知判别式在**两层都弄不坏**更旧的适配层：
  wire reader fail open（跳过该行、保留 chunk 里其余内容、交给
  `onProtocolError`），fold 则忽略并记录。两者都见
  [可观测性](#unhandledevents--我们没能投影的内容)。
- assistant-ui 的 part 联合类型只会增加字段。我们发布的是**本地结构化类型**，
  而不是导入它们的；`tests/assistant-ui-conformance.test.ts` 会把我们产出的东西
  赋给真实的 `@assistant-ui/core` 类型 —— 上游一旦挪动字段，
  `pnpm typecheck` 就会在那里失败，而不是在某个使用者的应用里失败。

有一处边界是刻意宽松的：`setMessages` 接受 `AuiInboundMessage`
（content 为 `string | readonly unknown[]`），因为分支切换会交回 assistant-ui
自己产出的消息，其中可能含本包从不产出的 part。它们会被原样存储与转发，不做
检查。这是适配层里唯一一处 cast。

## 覆盖范围

assistant-ui 的元素目录分成三块：

- **由上述 part 驱动** —— Thread、Message、Markdown、Reasoning、Tool call /
  group / fallback / failure、Code diff、Terminal block、Data table、
  Approval card、Permission grant、Question flow、Guardrail notice、Stopped run、
  Connection state、Error state、Cost meter（来自 `usage.costUsd`）、
  Model selector（来自 `models()`）、Reasoning effort、Context display、
  Thread list、MCP config dialog。
- **由 `data-*` 通道驱动** —— Spec sheet、Report、Sources、Inline citation、
  Retrieval chunks、Recommendation card、Score breakdown、Todo list、Chart、
  Map、Memory、File tree、Subagent list。
- **本库不覆盖** —— Edit a sent message、Regenerate with、Message branches、
  Checkpoints（都需要截断历史，而没有任何 CLI 支持 —— 见上）、Trace waterfall
  （我们有 run 级事件，没有 span）、Flow graph、Computer use、Schedule，
  以及跨 run 的分析（Activity / Heat graph —— run journal 里有事件，但建索引
  是你后端的活）。

还有一点很容易被误读：**审批门目前只有 claude 支持**，因为它是唯一会产出带可
关联 id 的 `permission_request` 的 runtime。

## 相关

- [frontend.md](./frontend.md) —— 本适配层实现的线路契约
- [bff.md](./dev/getting-started/bff.md) —— BFF cookbook
- [assistant-ui cookbook](./dev/getting-started/assistant-ui.md) —— 可粘贴的
  provider 与工具卡片
