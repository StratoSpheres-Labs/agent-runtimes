# Mode Map（模式对照表）

"Plan 模式"在三家 CLI 嘴里是三件事。本页是唯一的翻译表：左边是人话，
右边是本库字段。契约细节在 [frontend.md](../../frontend.md)，逐 flag
验证记录在各 `runtimes/<id>/definition.ts`。

## 规则：两个轴，永远不是一个 "mode"

- **Permission**（允许干什么）：只读 vs 可写。安全边界——配错会写坏盘。
- **Agent**（谁来干）：具名行为预设（`plan`、`build`……）。行为选择——
  同名在不同项目是不同文件。

之所以没有统一的 `mode: "plan" | "build"` 字段：Claude 的 plan（权限位）
≠ Codex 的 read-only（沙箱+审批策略）≠ OpenCode 的 plan-agent（prompt
预设）。一个枚举每次调用至少对一家撒谎。

## "我要只读 / plan"各家怎么写

| 你说的话         | 本库字段                                          | 原生效果                                                                                                                |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Claude 只读      | `workspace: { permissionMode: "plan" }`           | `--permission-mode plan`                                                                                                |
| Codex 只读       | `workspace: { sandboxMode: "read-only" }`         | `--sandbox read-only`（新建）/ `-c sandbox_mode="read-only"`（resume）                                                  |
| OpenCode 只读    | —— 无 channel                                     | `workspace` 直接大声拒绝（`workspace: false`，已对 `opencode run --help` 验证）                                         |
| OpenCode via ACP | —— 无 flag                                        | 权限走交互（`onPermissionRequest` / `respondToPermission`），不用 flag                                                  |
| Codex 自动过审   | `workspace: { autoReview: true }`                 | `--approve-for-me`（强制 `workspace-write` + `on-request`；与 `sandboxMode`/`dangerouslySkipPermissions` 同传直接抛错） |
| 全开逃生口       | `workspace: { dangerouslySkipPermissions: true }` | Claude `--dangerously-skip-permissions` / Codex `--dangerously-bypass-approvals-and-sandbox`；不支持的 runtime 大声拒绝 |

注意：

- 值**原样透传，不校验**（`createSession` 只门控 capability 是否支持）。
  `permissionMode` 拼错要到 spawn 才炸，值列表以本地 `--help` 为准，
  库不会替你纠正。
- Codex 沙箱有平台默认值：显式 `sandboxMode` 永远赢，否则看
  `OD_CODEX_SANDBOX` 环境变量，否则 win32/WSL 默认
  `danger-full-access`、POSIX 默认 `workspace-write`（Windows 没有可用
  的 OS 级沙箱——已验证）。
- OpenCode 离"plan"最近的是下面的 `agent: "plan"`——行为预设，**不是**
  权限边界，别混为一谈。

## "我要 plan/build agent"各家怎么写

| Runtime          | 本库字段                          | 原生效果                         | 名字来源                                             |
| ---------------- | --------------------------------- | -------------------------------- | ---------------------------------------------------- |
| OpenCode         | `agent: "plan"`（或 `"build"`……） | `--agent <name>`                 | workspace 配置——**不可信输入**，透传 + argv sanitize |
| Claude           | `agent: "<name>"`                 | `--agent <name>`（2.1.278 验证） | 同上                                                 |
| Codex            | —— 无                             | 无 `--agent` channel             | n/a                                                  |
| OpenCode via ACP | —— 无                             | 传导的是权限，不是 agent         | n/a                                                  |

Agent 名不可移植：A 仓库的 `plan` 和 B 仓库的 `plan` 是两个文件。库只
传字符串，不为内容背书。同上，名字写错到 spawn 才炸。

## 同一袋子里的邻居字段

- `allowedPaths`——Claude `--add-dir`、Codex `-C`（仅新建）；无 channel
  的 runtime 大声拒绝。
- `allowedTools`——仅 Claude `--allowedTools`（逐条 sanitize；漏掉一条就
  等于静默放宽权限）。
- `systemPrompt`——仅 Claude `--append-system-prompt`，只追加不替换。
- `reasoning.effort`——统一 `low|medium|high` → Claude `--effort`、
  Codex `-c model_reasoning_effort=`。

## 缺口（现在哪都表达不了——候选字段，一次一个）

- Codex 独立审批策略（`--ask-for-approval
untrusted|on-failure|on-request|never`）：今天只能经 `autoReview`
  附带的 `on-request` 间接够到。
- `permissionMode`/`sandboxMode` 的值目录（像 `isKnownModel` 那样的前置
  校验）：没验证过 live 列表 channel，拼错还是到 spawn 才炸。
- `opencode run` 的一切权限/沙箱：原生就没有这个 flag。

缺口转正的条件：验证过的原生 channel + capability 门 + 不支持时大声
拒绝——绝不给跨 runtime 预设名。

## 下一步

- [Quickstart](./quickstart.md)——这些字段插进去的 session 流程。
- [BFF](./bff.md)——上层拿它们做什么。
- [前端契约](../../frontend.md)——模式被拒时的错误码。
