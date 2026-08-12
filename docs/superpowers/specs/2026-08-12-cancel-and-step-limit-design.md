# 取消/中断与步数限制：客户端持有循环

## 目标

让 `execution: 'server'` 工具路径获得可中断能力，并把步数限制的主控权移到客户端。

实现方式是给 harness 增加可选的分步模式（`stepMode`），使服务端工具在每一步之后把控制权交还调用方。取消即「不再请求下一步」，无需服务端中断在途异步循环。

## 背景：为什么 server 路径没有取消能力

### remote 路径早已可中断

[harness.ts:245](../../../packages/core/src/harness.ts:245) 在本轮存在远端调用时落库并返回：

```ts
if (remoteCalls.length > 0) {
  await deps.sessions.save(sessionId, history)
  return { type: 'pending_tool_calls', calls: remoteCalls }
}
```

HTTP 请求就此结束，循环被切成一段一段。浏览器插件持有自己的循环（`runAgentSession`），在其中检查取消信号与步数上限，因此取消只需「停止回填」——服务端无须参与。

[harness.ts:269](../../../packages/core/src/harness.ts:269) 的注释确认这是既定设计：残破历史是「用户停止、断连、sidepanel 关闭」的产物，`sanitizeIncompleteRounds` 负责在下次指令时善后。

### server 路径没有挂起点

`flutter-dev-bff` 的 21 个工具全部是 `execution: 'server'`，`remoteCalls` 恒为空，上述 `return` 永不触发。整个循环——N 次模型调用与 N 轮工具执行——在同一个 `POST /run` 内跑完，中途没有任何返回点。客户端没有「拒绝继续」的机会，断开连接只是丢弃响应，服务端照样跑到底。

### 工具层抛错无法中断循环

在工具包装层检查取消标志并抛错是不可行的。[harness.ts:229](../../../packages/core/src/harness.ts:229) 捕获 `execute` 抛出的任何错误，转成 `ok: false` 的工具结果塞回历史后 `continue`：

```ts
} catch (error) {
  const code = error instanceof AgentKitError ? error.code : 'TOOL_EXECUTION_ABORTED'
  history.push({ role: 'tool', content: { ok: false, code, ... }, callId: call.callId, ... })
  continue
}
```

注释说明这是有意为之：「单个工具的执行失败不中断整轮：把失败结果一并回传，让模型自己决定如何补救」。因此抛错的效果是模型看到工具失败后重试，反而多消耗步数。

## 设计决策

### 客户端持有循环，而非服务端中断

两种方案：服务端维护在途运行表并透传 `AbortSignal`；或让服务端每步返回、由客户端驱动循环。选择后者。

决定性理由是 steering（中途注入消息改变方向）。中断与注入是同一个原语——两者都需要「每步之间有一个能接外部输入的点」。客户端持有循环时这个点是结构性的；服务端持有循环时，每增加一种外部干预都要在循环内多写一处轮询检查，并处理「干预到达时运行刚好结束」的竞态。

附带收益：无服务端在途状态、无竞态、BFF 重启不影响在途任务（历史已落 SQLite）、两条路径的循环形状统一。

### 以可选 `stepMode` 引入，而非统一返回类型

分步能力做成调用方显式启用的选项，不改变默认行为。

这不是为兼容而做的妥协。remote 工具本来就每步返回，插件早已具备该挂起点；`stepMode` 的作用是**让 server 工具追平 remote 工具已有的能力**。两条路径的返回类型天然应当不同：

- remote 需要表达「这些调用交给你执行并回填」→ `pending_tool_calls`
- server 需要表达「这一步已完成，需要时叫我继续」→ `step_done`

该差异源于工具执行方所在位置，并非 `stepMode` 引入的。统一返回类型无法消除它——remote 仍需自己的类型——只会多改一个项目而换不到架构简化。

### 浏览器插件零改动

已核实三点：

1. 插件 `src/` 下从未 import `@agent-kit/core`，package.json 中的该依赖是空挂声明，因此 core 类型变更在编译期无法影响它。
2. 插件在 `agentClient.ts:37` 自行声明 `AgentRunResult`，只含 `final` 与 `pending_tool_calls`。core 的 `HarnessResult` 新增变体不影响这份本地声明。
3. 插件运行期不发送 `stepMode`，因此永不接收 `step_done`。

### 保留服务端 `maxSteps` 作为兜底

步数限制主控权移到客户端后，服务端 `maxSteps` 退化为兜底，但**不移除**。

两者不是替代关系：客户端限制在有人监看时生效；服务端兜底在无人监看时生效（接入 CI、定时任务、批量执行时唯一的防护）。

**服务端兜底必须显著高于客户端默认值**，否则两者会同时触发，兜底失去意义。定为客户端默认 200、服务端 500：正常情况下客户端先停并给出明确提示，服务端 500 只在客户端限制被绕过或未生效时才触发。

`flutter-dev-bff` 当前的 `maxSteps: 50` 应调至 500。它是 core 的真实总任务上限，与插件那个可跨请求无限延长的 50 语义不同。

## 组件设计

### core

`contracts.ts` 的 `HarnessResult` 新增变体：

```ts
| { type: 'step_done' }
```

`harness.ts`：

- `AgentHarness.run` 请求类型增加 `stepMode?: boolean`。
- `AgentHarness` 新增推进方法。不可复用 `resume`——后者要求 `callId`，而分步推进没有待回填调用。
- `runLoop` 增加 `stepMode` 参数；在 server 工具执行完毕、[harness.ts:247](../../../packages/core/src/harness.ts:247) 的 remote 检查之后，落库并返回 `step_done`。

### bff-hono

`/run` 路由接收并校验 `stepMode` 后透传。

新增 `POST /v1/agent/sessions/:sessionId/continue`，`input` 为可选字段：

```
POST /continue {}                              → 推进一步
POST /continue { input: "别点那个，先看日志" }    → 注入消息后推进
```

steering 由此免费获得，无需额外设计。

注意现有 `/run` 在 [bff-hono/src/index.ts:37](../../../packages/bff-hono/src/index.ts:37) 强制要求 `input` 非空，`/continue` 不能沿用该校验。

`/continue` 收到没有在途运行的 session 时返回明确错误，不静默开启新循环。

### flutter-dev-bff Web UI

从「发一个请求等结果」改为循环驱动：`/run` → `step_done` → `/continue` → 直至 `final`。

新增停止按钮与步数计数，步数上限默认 200 且可配置（服务端兜底为 500，见上）。

## 实现期必须验证的点

`run()` 会调用 `sanitizeIncompleteRounds` 裁掉「有 toolCalls 但无对应结果」的 assistant 消息。分步返回时该轮 server 工具均已执行完毕、结果已入历史，因此裁剪预期是 no-op。

**这是推断，非已验证结论。** 必须先写测试确认。若判断有误，每次 `/continue` 都会静默吃掉上一步历史。

## 测试策略

core：

- `stepMode` 启用时在每步后返回 `step_done`。
- `stepMode` 关闭时行为与现状完全一致。
- `sanitizeIncompleteRounds` 不破坏分步历史（见上）。
- 连续推进可到达 `final`。

bff-hono：

- `/continue` 端点正常推进。
- `/continue` 的 `input` 可选。
- `stepMode` 参数校验。
- `/continue` 无在途 session 时报错。

flutter-dev-bff：Web UI 循环驱动、停止按钮生效、步数上限触发后停止。

按 [AGENTS.md](../../../AGENTS.md) 规范，须跑 `pnpm -r typecheck && pnpm -r test && pnpm -r build`，确认现有 145 个测试全部通过，其中 browser-extension-bff 的 26 个测试是插件路径未被破坏的证据。

## 范围之外

- 同时包含 remote 与 server 工具的 BFF（`stepMode` 与 `resume` 的交互语义）。当前 flutter-dev-bff 全为 server 工具、插件全为 remote 工具，不存在混用。
- 清理插件中空挂的 `@agent-kit/core` 依赖。
- 移除 core 的 `maxSteps`。
- SSE 实时进度：见 [桥接层重构与 SSE 实时进度设计](2026-08-12-flutter-bff-sse-design.md)。该设计需据本设计修订——客户端持有循环后，SSE 简化为步内可见性，`run_start`/`run_end` 与 runId 全部不再需要。保留 SSE 的理由是 flutter 单个工具最长 300 秒（`flutter_test`），步粒度不足以覆盖该盲区。
