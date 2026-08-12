# Flutter Dev BFF：SSE 步内可见性

## 目标

向 Web UI 实时推送工具执行事件，使长耗时工具运行期间能看清 Agent 正卡在哪一步。

## 前置条件（已完成）

本设计原本还包含桥接层重构与 loopback 绑定两项，均已实现并合入 `main`：

- `e8ed947` — 用 `@hono/node-server` 替换手写桥接，修复截图 PNG 二进制损坏
- `678f8f6` — 显式绑定 `127.0.0.1`

这两项是 SSE 的前置条件：手写桥接用 `res.end(await response.text())` 缓冲整个响应体，流式推送无法成立；loopback 绑定则是「不做会话隔离」这一决策的安全前提。

实现后 `flutter-dev-bff` 测试数从 19 增至 22，全 workspace 148 个测试通过。

## 背景：为什么步粒度不够

`flutter-dev-bff` 的工具耗时远超浏览器工具：

```
flutter_test        300_000ms
flutter_analyze     120_000ms
flutter_run_start   120_000ms
mobile_app_install  120_000ms
```

浏览器插件的工具是 DOM 操作，亚秒级完成，步边界足以提供进度感。flutter 这边单个工具可运行 5 分钟，期间界面完全静止。

[取消/中断与步数限制设计](2026-08-12-cancel-and-step-limit-design.md) 引入客户端持有循环后，盲区从「整个任务」缩小到「一步」。但一步不等于一瞬间——一步包含一次模型调用与该轮全部 server 工具执行，因此含 `flutter_test` 的步骤仍会阻塞 5 分钟。SSE 覆盖的正是这段步内盲区。

**本设计不依赖该取消设计先落地。** 两者独立：推送的事件类型完全相同，客户端持有循环只改变 SSE 覆盖盲区的比例，不改变事件结构。

## 设计决策

### 不做会话隔离

会话隔离与网络隔离是两个独立维度。前者决定同进程内不同会话是否互相可见，后者决定其他机器能否连入。

交付给研发和测试后，每人在自己机器上运行独立进程、独立数据库、独立设备，进程之间物理不连通。服务已绑定 `127.0.0.1`，因此广播范围即单机单人，不构成信息泄露。多标签页并发时只会看到自己另一标签页的工具调用。

因此不实现 `/api/events/:sessionId`，改为单一广播端点 `/api/events`。这同时规避了一个结构性障碍：core 的 `ToolExecutionContext` 只透传 `signal`，包装后的 `execute` 无法得知 sessionId，按会话分发需要引入 `AsyncLocalStorage` 或修改共享契约。

### SSE 而非 WebSocket 或轮询

Agent 中间态是服务端单向持续推送，与 SSE 形态一致。SSE 是普通 HTTP，不升级协议；`EventSource` 自带断线重连与 `Last-Event-ID` 续传。

已知代价及其在本场景的影响：

- 单向通信：无影响，用户输入仍走 `/run`。
- HTTP/1.1 同域连接数上限 6：本地开发不会开这么多标签页。
- 中间层缓冲会导致事件成块延迟：本地直连无此层，日后若加网关需关闭 buffering。
- 只能传文本：截图仍走 `/api/screenshots/:id` 独立二进制路由。

### 不设 `run_start` / `run_end`

无论是否启用客户端持有循环，Web UI 都自己发起请求，天然知道运行何时开始、何时结束。服务端再告知一遍不携带新信息，反而制造两个「结束」信号（SSE 与 HTTP 响应是两条独立连接，到达顺序无保证），多一个状态源即多一类 bug。

`run_end` 若携带 steps 字段则无法填充：步数是 harness 内部的局部循环变量（[harness.ts:154](../../../packages/core/src/harness.ts:154)），BFF 包装层看不见。改为统计 `tool_end` 事件数也不正确——一步可含多个 `tool_calls`，且最后一步通常无工具调用。

### 事件分两档，verbose 只推摘要

默认档推工具级事件。`LOG_LEVEL=verbose` 时额外推 LLM 级事件，与现有 verbose 日志开关一致。

`LlmTraceEvent` 的 `body` 是完整 HTTP 请求体（含 system prompt 全文与全部会话消息），`responseBody` 是模型原文。这与 `AuditLogger` 契约明确禁止记录的内容重叠，因此即使在 verbose 档也**只推摘要字段**，不推 `body` 与 `responseBody`。

### SSE 鉴权走查询参数

浏览器 `EventSource` API 不支持自定义请求头，现有 `Authorization: Bearer` 方案在 SSE 上不可用。

选择 `?token=` 查询参数配合 `EventSource`，保留自动重连。代价是 token 会落入日志。备选方案是 `fetch` + `ReadableStream`，可携带 header，但需自行实现重连逻辑。

服务只绑 loopback 且为本地单人开发工具，接受该代价以换取不必手写重连。

## 组件设计

### EventBus

新增 `src/services/event-bus.ts`，纯内存、无外部依赖。

```
createEventBus({ bufferSize: 200 })
  emit(event)                    // 自动补 seq 与 ts
  subscribe(listener, fromSeq?)  // 返回 unsubscribe
```

环形缓冲保留最近 200 条。缓冲的必要性在于 `EventSource` 重连时携带 `Last-Event-ID`，需靠缓冲补齐断开期间的事件，否则重连等于丢事件。

### 工具包装

在 BFF 层包装，不修改 core。`ToolDefinition.execute` 是可选普通函数，map 一层即可：

- 执行前发 `tool_start`。
- 成功发 `tool_end`（`ok: true`，含 durationMs 与截断后 output），返回原值。
- 抛错发 `tool_end`（`ok: false`，含错误信息），随后**原样抛出**，不吞异常。
- `execute` 未定义的工具原样透传。

输入与输出经 `truncate` 处理，上限 2KB，超出部分标记截断。截断是必需的：`mobile_snapshot` 返回整棵无障碍树，单条事件可达数十 KB，长任务累积会拖垮浏览器。

注意抛错后必须原样抛出而非转换：harness 会捕获工具错误并转成 `ok: false` 结果回传给模型（[harness.ts:229](../../../packages/core/src/harness.ts:229)），改变异常类型会干扰该机制。

### 事件类型

默认档：

```
tool_start  { name, input, seq, ts }
tool_end    { name, ok, durationMs, output? | error?, seq, ts }
```

`LOG_LEVEL=verbose` 额外：

```
llm_request  { requestId, model, messageCount, toolCount }
llm_response { requestId, durationMs, finishReason, toolCallCount }
```

LLM 事件通过组合 `llmTrace` 回调实现：verbose 档下传入的回调同时写终端日志并向 EventBus 发摘要事件，从 `LlmTraceEvent` 中只提取上述字段。

### SSE 端点

`GET /api/events?token=...`

- token 校验失败返回 401。
- 响应 `Content-Type: text/event-stream`。
- 支持 `Last-Event-ID` 从指定 seq 重放。
- 每 15 秒发送一个 `:` 注释行作为心跳，保持连接并检测死客户端。
- 客户端断开时从订阅列表移除，避免内存泄漏。

### Web UI

加载时建立 `EventSource` 连接，将工具事件实时渲染进消息列表，替换现有的静态「思考中...」状态。已有的最终结果渲染逻辑保持不变。

## 测试策略

采用 TDD，先写测试。

- EventBus：seq 单调递增、订阅者收到事件、退订后停止接收、缓冲不超上限、按 seq 重放。
- 工具包装：发出 start 与 end 事件、透传返回值、抛错时发出 error 事件且异常原样抛出、无 execute 的工具透传。
- 截断：超长 payload 被截断并标记。
- SSE 端点：无 token 返回 401、有 token 返回 `text/event-stream`、能接收到事件、`Last-Event-ID` 重放生效。

SSE 端点测试须启动真实监听端口（复用 `bridge.test.ts` 中的 `startFlutterDevBffServer` 模式）——`app.request()` 无法验证流式响应。

现有 148 个测试须保持通过。

## 范围之外

- 会话隔离（`/api/events/:sessionId`）。
- 修改 `browser-extension-bff`。它的桥接代码有同源缺陷但无二进制路由，因此未暴露；它也因此无法做 SSE。
- 修改 core 的 `ToolExecutionContext` 契约。
- 流式 LLM 输出：core 当前不支持。
- 真机端到端验证：本设计完成后单独进行，SSE 将作为其观察窗口。
- Phase 4 Companion App 与 Phase 5 WebView CDP。

## 遗留风险

`.env` 模板默认 token 为 `dev-token`。绑定 loopback 后局域网风险已消除，但若日后有人显式改绑 `0.0.0.0`，弱默认 token 会再次成为问题。本设计不改动该默认值，仅记录此依赖关系。
