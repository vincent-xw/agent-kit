# Flutter Dev BFF：桥接层重构与 SSE 实时进度

## 目标

修复 `examples/flutter-dev-bff` 的 HTTP 桥接层缺陷，并在其上实现工具执行的实时事件推送，使真机调试时能看清 Agent 正在执行哪一步。

本设计覆盖三件事：

1. 替换手写的 Node ↔ Hono 桥接，修复截图二进制损坏。
2. 将服务绑定限制在 loopback，使「不做会话隔离」的安全前提成立。
3. 新增 EventBus 与 SSE 端点，向 Web UI 推送工具级执行事件。

## 背景：两个已确认的缺陷

### 截图二进制损坏

`src/server.ts` 的桥接用 `res.end(await response.text())` 把响应体按 UTF-8 文本解码。`/api/screenshots/:id` 返回 PNG 二进制，经此路径后字节被破坏。

实测：19 字节 PNG 头变成 27 字节，magic byte `0x89` 被替换为 `ef bf bd`（U+FFFD）。Web UI 通过 `<img src="/api/screenshots/...">` 渲染截图，因此缺陷用户直接可见。

同样的桥接代码存在于 `browser-extension-bff`，但该 example 没有二进制路由，所以未暴露。本设计只修改 `flutter-dev-bff`。

### 服务暴露在局域网

`server.listen(port, ...)` 未传 host 参数。实测 Node 此时绑定 `::`（全部网卡），通过本机局域网地址可直接访问成功。

叠加两个因素后风险放大：

- 自动生成的 `.env` 模板默认写入 `BFF_API_TOKEN=dev-token`。
- 事件推送不做会话隔离，一个连接可见全部工具事件。

结果是同一局域网内任何人都可连接他人的 BFF、观察其事件流、操作其设备、触发其 `flutter test`。

## 设计决策

### 绑定 loopback，不做会话隔离

会话隔离与网络隔离是两个独立维度。前者决定同进程内不同会话是否互相可见，后者决定其他机器能否连入。

交付给研发和测试后，每人在自己机器上运行独立进程、独立数据库、独立设备，进程之间物理不连通。在服务只绑 `127.0.0.1` 的前提下，广播范围即单机单人，不构成信息泄露。多标签页并发时只会看到自己另一标签页的工具调用。

因此不实现 `/api/events/:sessionId`，改为单一广播端点 `/api/events`。这同时规避了一个结构性障碍：core 的 `ToolExecutionContext` 只透传 `signal`，包装后的 `execute` 无法得知 sessionId，按会话分发需要引入 `AsyncLocalStorage` 或修改共享契约。

绑定地址显式写死，不依赖库的默认值。

### SSE 而非 WebSocket 或轮询

Agent 中间态是服务端单向持续推送，与 SSE 形态一致。SSE 是普通 HTTP，不升级协议；`EventSource` 自带断线重连与 `Last-Event-ID` 续传。

已知代价及其在本场景的影响：

- 单向通信：无影响，用户输入仍走 `/run`。
- HTTP/1.1 同域连接数上限 6：本地开发不会开这么多标签页。
- 中间层缓冲会导致事件成块延迟：本地直连无此层，日后若加网关需关闭 buffering。
- 只能传文本：截图仍走 `/api/screenshots/:id` 独立二进制路由，因此桥接层必须同时正确支持二进制与流式。

### 事件分两档，verbose 只推摘要

默认档推工具级事件。`LOG_LEVEL=verbose` 时额外推 LLM 级事件，与现有 verbose 日志开关保持一致。

`LlmTraceEvent` 的 `body` 是完整 HTTP 请求体（含 system prompt 全文与全部会话消息），`responseBody` 是模型原文。这与 `AuditLogger` 契约明确禁止记录的内容重叠，因此即使在 verbose 档也**只推摘要字段**，不推 `body` 与 `responseBody`。

### SSE 鉴权走查询参数

浏览器 `EventSource` API 不支持自定义请求头，现有 `Authorization: Bearer` 方案在 SSE 上不可用。

选择 `?token=` 查询参数配合 `EventSource`，保留自动重连。代价是 token 会落入日志。备选方案是 `fetch` + `ReadableStream`，可携带 header，但需自行实现重连逻辑。

在服务只绑 loopback、且为本地单人开发工具的前提下，接受该代价以换取不必手写重连。

## 组件设计

### 桥接层

删除 `createServer`、`readBody`、header 拷贝循环与 `res.end(await response.text())`，替换为：

```ts
import { serve } from '@hono/node-server'
await bff.ready
serve({ fetch: bff.app.fetch, port, hostname: '127.0.0.1' })
```

新增生产依赖 `@hono/node-server`。约 30 行桥接代码缩减为 3 行，二进制与流式响应由适配器处理。

`await bff.ready` 由「每请求前 await」上提为启动时一次（ESM 顶层 await），行为等价。`ready` 仍然导出，测试继续使用。

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

输入与输出经 `truncate` 处理，上限 2KB，超出部分标记截断。截断是必需的：`mobile_snapshot` 返回整棵无障碍树，单条事件可达数十 KB，50 步累积会拖垮浏览器。

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

不设 `run_start` / `run_end` 事件。Web UI 自己发起 `/run` 请求，天然知道运行何时开始、何时随响应结束，无需服务端告知。此外步数是 harness 内部状态，BFF 包装层无法得知，`run_end` 携带的 steps 字段无法填充。

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

### 截图回归测试

缺陷位于桥接层而非 Hono app 内部，直接调用 `app.fetch` 无法复现。测试必须真实启动 `serve()` 监听临时端口，通过 `fetch` 取回 PNG 并逐字节比对，才能证明修复有效。

### 其余覆盖

- EventBus：seq 单调递增、订阅者收到事件、退订后停止接收、缓冲不超上限、按 seq 重放。
- 工具包装：发出 start 与 end 事件、透传返回值、抛错时发出 error 事件且异常原样抛出、无 execute 的工具透传。
- 截断：超长 payload 被截断并标记。
- SSE 端点：无 token 返回 401、有 token 返回 `text/event-stream`、能接收到事件、`Last-Event-ID` 重放生效。

现有 19 个测试须保持通过。

## 范围之外

- 会话隔离（`/api/events/:sessionId`）。
- 修改 `browser-extension-bff` 的同源桥接代码。
- 修改 core 的 `ToolExecutionContext` 契约。
- 真机端到端验证：本设计完成后单独进行，SSE 将作为其观察窗口。
- Phase 4 Companion App 与 Phase 5 WebView CDP。

## 遗留风险

`.env` 模板默认 token 为 `dev-token`。绑定 loopback 后局域网风险已消除，但若日后有人显式改绑 `0.0.0.0`，弱默认 token 会再次成为问题。本设计不改动该默认值，仅记录此依赖关系。
