# Agent Kit

面向项目 BFF 与 Cloudflare Worker 的最小 Agent 运行时。

## 包

- `@agent-kit/core`：工具注册、session、受限 harness 与稳定错误码。
- `@agent-kit/adapter-cloudflare`：Worker Secret Binding 与 D1 session store。
- `@agent-kit/adapter-sqlite`：Node BFF SQLite session、挂起调用表与 AES-256-GCM 密钥库。
- `@agent-kit/bff-hono`：鉴权 BFF 路由与远端 Tool Host 回填协议。

## 工具调用

已注册工具的输入 Schema 会经 `toToolSchema` 转为 JSON Schema，并作为 `tools` 字段随每次补全请求发给模型——不发这个字段模型就不知道有哪些工具可调。工具注册表通过 `list()` 枚举，`ToolRegistry` 的实现方需提供该方法。

一轮响应内的**全部** `tool_calls` 都会被处理，`LlmResult` 与 `HarnessResult` 因此是复数形态（`tool_calls` / `pending_tool_calls`）。工具结果消息携带 `tool_call_id` 与其发起调用关联；assistant 轮次会连同它发起的 `toolCalls` 一并入库，使模型在后续轮次能看到自己的上一轮输出。

服务端工具通过 `execute(input, { signal })` 执行，受 `timeoutMs`（工具级）或 `toolTimeoutMs`（harness 级，默认 30 秒）约束。运行期失败会作为工具结果回传给模型让其自行补救；Schema 校验失败属于契约违约，直接抛 `TOOL_INPUT_INVALID` / `TOOL_OUTPUT_INVALID`。

## 安全规则

浏览器扩展、H5 与网页前端不得保存 `LLM_API_KEY`，也不得直接请求模型接口。无 Cloudflare Secret 能力的项目必须部署自己的 Node BFF，并由 BFF 设置 `AGENT_KIT_MASTER_KEY`（32 字节 base64url）以加密 SQLite 中的模型密钥。

Cloudflare 项目由 Worker Secret Binding 提供 Key、Base URL、模型；session 存入 D1。BFF/Worker 日志不得记录密钥、Prompt 正文、模型原文或业务上下文。

## 浏览器 Tool Host

插件调用 `POST /v1/agent/sessions/:sessionId/run`。若响应为 `pending_tool_calls`，插件只能执行已注册白名单工具，并对**每个** `callId` 调用 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填结果；同轮全部回填完毕后 harness 才推进模型，未填完时接口继续返回剩余的 `pending_tool_calls`。BFF 负责鉴权并将用户主体传入 harness。

挂起调用状态由 `PendingCallStore` 持有。默认实现是进程内 Map（进程重启即丢），生产环境应注入持久化实现——`@agent-kit/adapter-sqlite` 的 `createSqlitePendingCallStore` 即为此提供。

## 接入文档

- [Cloudflare Worker 接入](docs/integrations/cloudflare-worker.md)
- [浏览器扩展 + BFF 接入](docs/integrations/browser-extension-bff.md)
- [安全说明](docs/security.md)

## 验收清单

- [x] Cloudflare 示例未向前端暴露 `LLM_API_KEY`
- [x] BFF 示例未在扩展配置中出现 Endpoint、模型或 API Key
- [x] SQLite 示例要求设置 `AGENT_KIT_MASTER_KEY`
- [x] 工具示例声明 `execution: 'remote'`

## 命令

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
