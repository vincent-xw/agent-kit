# Agent Kit

面向项目 BFF 与 Cloudflare Worker 的最小 Agent 运行时。

## 包

- `@agent-kit/core`：工具注册、session、受限 harness 与稳定错误码。
- `@agent-kit/adapter-cloudflare`：Worker Secret Binding 与 D1 session store。
- `@agent-kit/adapter-sqlite`：Node BFF SQLite session 与 AES-256-GCM 密钥库。
- `@agent-kit/bff-hono`：鉴权 BFF 路由与远端 Tool Host 回填协议。

## 安全规则

浏览器扩展、H5 与网页前端不得保存 `LLM_API_KEY`，也不得直接请求模型接口。无 Cloudflare Secret 能力的项目必须部署自己的 Node BFF，并由 BFF 设置 `AGENT_KIT_MASTER_KEY`（32 字节 base64url）以加密 SQLite 中的模型密钥。

Cloudflare 项目由 Worker Secret Binding 提供 Key、Base URL、模型；session 存入 D1。BFF/Worker 日志不得记录密钥、Prompt 正文、模型原文或业务上下文。

## 浏览器 Tool Host

插件调用 `POST /v1/agent/sessions/:sessionId/run`。若响应为 `pending_tool_call`，插件只能执行已注册白名单工具，并调用 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填结果；BFF 负责鉴权并将用户主体传入 harness。

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
