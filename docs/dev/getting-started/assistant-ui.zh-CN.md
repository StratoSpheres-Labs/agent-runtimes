# assistant-ui Cookbook

把 `agent-runtimes` 接进 React 聊天界面的可粘贴配方。契约在
[frontend.md](../../frontend.md)；适配层的设计与完整事件映射在
[frontend-assistant-ui.md](../../frontend-assistant-ui.zh-CN.md)。

这一页是**怎么做**。请在读完 BFF 那一片
（[bff.md](./bff.md)）之后再看 —— UI 需要一个会流式输出 `RuntimeEvent` 的后端。

## 安装

```bash
pnpm add @stratosphereslab/agent-runtimes @assistant-ui/react
npx assistant-ui@latest add thread     # Thread + Composer 组件
```

**想先看整条链路跑起来？** 在本仓库的 clone 里：

```bash
pnpm build            # 产出 dist/assistant-ui.js
pnpm example:bff-ui   # http://localhost:3000
```

这个 demo（`examples/bff-assistant-ui.ts`）就是下面这些片段对话的后端：transport
会调的那四条路由，外加一个直接从 `dist/` import bundle 的页面。动手写自己的之前
先读它 —— 它很短，而且它的路由由 `tests/bff-assistant-ui.test.ts` 覆盖，所以不是
那种会悄悄烂掉、只能手动跑的东西。

适配层发布在自己的子路径上，所以 Node 侧的东西不会进你的 bundle：

```ts
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";
```

> 永远不要在组件里 import `@stratosphereslab/agent-runtimes`（包根）—— 它会
> 重新导出仅 Node 可用的 API，打包器会在 `node:child_process` 上卡住。

## 1. Provider

```tsx
"use client";
import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import {
  createThreadStore,
  createExternalStoreAdapter,
  createRuntimeTransport,
} from "@stratosphereslab/agent-runtimes/assistant-ui";

export function AgentProvider({
  children,
  sessionId = "default",
}: {
  children: ReactNode;
  sessionId?: string;
}) {
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
          sessionId,
        }),
      }),
    [sessionId],
  );

  const runtime = useExternalStoreRuntime(createExternalStoreAdapter(store));
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

Provider 之下自动可用的是：流式文本、思考过程、工具卡片、取消（真实的服务端
中断）、用量/花费，以及审批门。

**你不会得到的是**：编辑、重新生成、分支。这几个按钮是**有意缺席**的 ——
所有支持 runtime 的 resume 都只会*延长*会话，所以"编辑后重问"会让 agent 悄悄
留着旧 transcript。详见
[frontend-assistant-ui.zh-CN.md](../../frontend-assistant-ui.zh-CN.md#不支持的部分编辑重新生成分支)。
真的需要回退，就开一个新的 `Session`。

## 2. 页面

```tsx
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentProvider } from "./AgentProvider";

export default function Page() {
  return (
    <AgentProvider>
      <Thread />
    </AgentProvider>
  );
}
```

## 3. 工具卡片

`tool_started` / `tool_finished` 会变成 assistant-ui 的 `tool-call` part，所以
开箱即用的渲染就够了。要自定义样式就注册一个渲染器 —— 这里以 `bash` 为例：

```tsx
import { useAuiState } from "@assistant-ui/react";

function BashToolUI() {
  const call = useAuiState((s) => s.part);
  if (call.type !== "tool-call") return null;

  const command = typeof call.args.command === "string" ? call.args.command : "";
  return (
    <div className="rounded border px-2 py-1 text-xs">
      <div className="font-mono">
        {call.status.type === "running" ? "…" : ""} $ {command}
      </div>
      {call.result !== undefined && (
        <pre className="mt-1 max-h-40 overflow-auto text-xs opacity-70">{String(call.result)}</pre>
      )}
      {call.isError === true && <div className="text-red-600">failed</div>}
    </div>
  );
}
```

来自 fold 的两点值得知道：

- `args` 永远是对象。非对象的 `tool_started.input` 会被包进 `value` 键，
  原始 JSON 仍在 `argsText` 里。
- `call.approval` 只在审批门开着时存在（见下一节）。

## 4. 审批门（Allow / Deny）

`permission_request` 会在 tool part 上设置 `approval: { id, prompt, options }`，
并把消息状态翻成 `requires-action`。assistant-ui 的 `ToolFallback` 在该状态下
已经会渲染 Allow / Deny，所以零代码路径是：

```tsx
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";

export function ApprovalUI() {
  const status = useAuiState((s) => s.part.status);
  return status.type === "requires-action" ? <ToolFallback /> : null;
}
```

**动手之前先确认这一点：审批门目前只有 `claude` 支持。** 它是唯一会产出
`permission_request` 的 runtime，也是唯一whose `PermissionRequest` 带有后端可
关联 id 的。`opencode-acp` 两样都没有，所以那里的 UI 审批往返必定 404 —— 改为
在 `onPermissionRequest` 内部应答。完整表格见
[frontend-assistant-ui.zh-CN.md](../../frontend-assistant-ui.zh-CN.md#ui-应答必须带的-id以及它在哪里断掉)。

如果你想展示 agent 自己的措辞和选项：

```tsx
import { useAuiState } from "@assistant-ui/react";
// `store` 是第 1 步里建的那个 —— 把它提到 context 里。

export function GateUI() {
  const part = useAuiState((s) => s.part);
  if (part.type !== "tool-call" || part.approval === undefined) return null;
  const { id, prompt, options } = part.approval;

  return (
    <div className="rounded border border-amber-400 p-2 text-xs">
      <p className="font-medium">{prompt ?? "The agent asks permission"}</p>
      <div className="mt-2 flex gap-2">
        {(options ?? [{ id: "allow", kind: "allow-once", label: "Allow" }]).map((o) => {
          const approved = !/reject|deny/i.test(o.kind);
          return (
            <button
              key={o.id}
              onClick={() => {
                // 应答送不出去时会 reject 并把审批门重新打开，
                // 所以卡片绝不会停在"已允许"而 agent 其实还在等。
                void store
                  .respondToApproval({ approvalId: id, approved, optionId: o.id })
                  .catch((err: unknown) => console.error("approval failed", err));
              }}
            >
              {o.label ?? o.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

推荐走 store 这条路 —— 它被本包的测试钉住了，不像 toolkit 的 helper 名字那样随
版本变动。关键在载荷：`optionId` 必须是该事件提供过的之一 —— 它在线路上就是
`WireRespondPermission { id, optionId }`，臆造的那个毫无意义。

React 之外同理：

```ts
import { createThreadStore } from "@stratosphereslab/agent-runtimes/assistant-ui";

const store = createThreadStore({ transport });
await store.respondToApproval({ approvalId: "p1", approved: true, optionId: "allow-once" });
```

卡片会立刻翻转；POST 被拒则意味着本地已应答但上游没有，这一情况应当暴露出来。

`permission_denied` **不是**审批门 —— harness 已经决定了。它表现为
`approval.approved === false` 加一个 `isError` 结果，所以请就地渲染"已阻止"，
而不是给按钮。

## 5. 思考过程

`reasoning_delta` 变成 `reasoning` part。assistant-ui 默认什么都不渲染，需要
显式开启：

```tsx
import { MessagePrimitive } from "@assistant-ui/react";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";

<MessagePrimitive.Parts>
  {({ part }) => (part.type === "reasoning" ? <Reasoning /> : part.toolUI)}
</MessagePrimitive.Parts>;
```

或者用 `groupBy` 折进 ChainOfThought 手风琴 —— `reasoning` 和 `tool-call`
都会归到它下面，而这正是 agent turn 的天然形状。

## 6. 花费与 token

`usage` 落在 `metadata.steps[].usage` 和 `metadata.custom` 上：

```tsx
function UsageBadge() {
  const meta = useAuiState((s) => s.message.metadata);
  const step = meta?.steps?.[0];
  if (step?.usage === undefined) return null;
  return (
    <span className="text-[10px] opacity-60">
      {step.usage.inputTokens} in / {step.usage.outputTokens} out
    </span>
  );
}
```

`usage.costUsd` 也被折叠了 —— 自行展示即可（assistant-ui 没有绑定到这个形状的
现成花费计量器）。

## 7. 用 `data-*` 承载结构化卡片

agent 产出的任何非文本内容都走 `data-*` 通道：

```ts
store.emit({ type: "data-spec-sheet", data: { title: "Q3 revenue", rows } });
```

```tsx
export function SpecSheet({ data }: { data: { title: string; rows: number } }) {
  return (
    <div className="rounded border p-2 text-xs">
      <div className="font-medium">{data.title}</div>
      <div>{data.rows} rows</div>
    </div>
  );
}

// 在 MessagePrimitive.Parts 里匹配 emit 出去的 part 并渲染：
//
//   {({ part }) =>
//     part.type === "data-spec-sheet" ? <SpecSheet data={part.data} /> : null
//   }
```

注意两种写法：`{ type: "data-spec-sheet", data }` 是 external-store 形式，
`{ type: "data", name: "spec-sheet", data }` 是 local-runtime 形式。`emit`
两种都收，`createChatModelAdapter` 在输出时会做转换。

## 8. 模型选择与思考强度

本包不接这两样 —— 列表归你管，数据源是后端的 `runtime.models()` 和
`runtime.capabilities().reasoning`：

```tsx
import { useState } from "react";

export function ModelRail() {
  // 数据来自你的后端，例如 GET /api/agent/models -> runtime.models()
  const [model, setModel] = useState("sonnet");
  return (
    <select value={model} onChange={(e) => setModel(e.target.value)}>
      <option value="sonnet">sonnet</option>
      <option value="opus">opus</option>
    </select>
  );
}
```

再把它传进后端的 `createSession({ model })` / `run(prompt, { model })` ——
浏览器永远看不到 CLI flag。

`models()` 和 `capabilities()` 是 Node 侧的只读发现接口；通过你自己的路由
暴露出来，再把值传进 session。

## 9. 错误

```tsx
import { ErrorPrimitive } from "@assistant-ui/react";

<ErrorPrimitive.Root>
  {/* 渲染消息状态里的 error。机器可读的 code 在
      message.metadata.custom.errorCode —— switch 它，绝不 switch 文案。 */}
  <ErrorPrimitive.Message />
</ErrorPrimitive.Root>;
```

```ts
const code = msg.metadata?.custom?.["errorCode"] as string | undefined;
switch (code) {
  case "STALL":
  case "TIMEOUT":
    return showRetry(); // 这一轮已死；给重试
  case "NON_ZERO_EXIT":
    return showAgentCrashed();
  case "PERMISSION_ANSWER_FAILED":
    return showStillWaiting(); // agent 仍在等待 —— 重试或取消
  default:
    return showGeneric();
}
```

在 `done` 之前被切断的 turn（网络掉线、组件卸载）会结算为
`incomplete` / `cancelled`，不会让消息永远停在 `running`。

## 10. 中途 steering（仅 ACP runtime）

```ts
const transport = createRuntimeTransport({ endpoints: { turn, send } });
await transport.send(runId, "actually use pnpm, not npm");
```

只有 ACP runtime 支持；stdio CLI 会拒绝，后端返回 `400`。把输入框队列接到它
上面（`unstable_enableMessageQueue` / `createMessageQueue`），这样运行中输入的
消息会去 steer 而不是报错。

## 坑

- **一个 session 同时只有一个活跃 run。** 有 turn 在流式输出时第二轮会拒绝
  （本地 `RuntimeSessionError`，后端 `409`）。先排空到 `done` —— 否则 resume
  会静默开启一个**全新**的上游 session 并丢失上下文。
- **续接前先排空。** 原生 session id 是从第 N 轮的事件流里捕获的，未排空的
  第 N+1 轮会开启新的上游 session。
- **给快照，不要给增量。** 如果你在 `createAssistantTurn` 之上自己写适配层，
  要整体 yield `snapshot()`。
- **绝不 emit 空的 text part。** 它会把前一个 part 标记为完成，从而截断正在
  流式输出的回答。`emit()` 宁可抛错。
- **`reasoning_delta` 仅供展示。** 它绝不是可续接的输入。
- **不要记录 `session.history()`。** 它默认已脱敏，但仍可能包含用户粘贴的
  密钥；未经明确同意绝不转发。

## 下一步

- [frontend-assistant-ui.zh-CN.md](../../frontend-assistant-ui.zh-CN.md) ——
  适配层设计、完整映射表，以及刻意不覆盖的部分
- [frontend.md](../../frontend.md) —— 线路契约与错误码分类
- [bff.md](./bff.md) —— 这个 UI 所依托的 BFF cookbook
