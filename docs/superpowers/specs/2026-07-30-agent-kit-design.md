# Agent Kit 设计说明

## 目标

构建一个可发布的 TypeScript npm workspace，用统一的 LLM 配置、系统提示词、密钥读取、上下文、工具注册和执行循环，为不同项目提供最小 Agent 运行时。

## 安全边界

- 浏览器、扩展和 H5 永远不接收、不存储、不直连使用 LLM API Key。
- `@agent-kit/adapter-cloudflare` 只从 Worker 的 `env` Binding 读取密钥。
- `@agent-kit/adapter-sqlite` 只在 Node BFF 使用 SQLite 读取密钥；密钥必须使用调用方提供的主密钥加密后保存。
- 未配置密钥时直接返回 `SECRET_NOT_CONFIGURED`，不读取 localStorage、不读取明文配置文件、不执行默认值兜底。
- 审计日志只记录 requestId、模型标识、耗时、HTTP 状态、工具名和错误码；不记录密钥、Prompt 正文、模型原文或业务上下文。

## 包边界

### `@agent-kit/core`

不依赖 Cloudflare、SQLite 或 Web 框架，提供：

- `LlmClient`：OpenAI Chat Completions 兼容 HTTP 请求、超时、响应提取和错误标准化。
- `PromptRegistry`：以 `name@version` 注册系统提示词及输出协议。
- `ContextManager`：按 session 保存消息、工具结果和摘要，并执行窗口裁剪。
- `ToolRegistry`：使用 Zod 定义工具输入、输出和执行权限。
- `AgentHarness`：最大步数受限的 `模型 -> 工具调用 -> 工具结果 -> 模型` 循环。
- `AuditLogger`、`SecretProvider`、`SessionStore` 等可替换接口。

### `@agent-kit/adapter-cloudflare`

提供 Cloudflare Worker 运行时实现：

- 从显式 Binding 名称读取 API Key、Base URL 和模型名。
- 使用 D1 作为 session/context 存储。
- 通过 `createCloudflareAgentRuntime(env, options)` 创建 core 所需依赖。

### `@agent-kit/adapter-sqlite`

提供 Node BFF 运行时实现：

- SQLite 表保存加密的 provider 配置与 session/context。
- 调用方在进程环境中提供 `AGENT_KIT_MASTER_KEY`；该主密钥不写入 SQLite。
- 通过 `createSqliteAgentRuntime(options)` 创建 core 所需依赖。

### `@agent-kit/bff-hono`

提供 Hono 路由模板和鉴权挂载点：

- `POST /v1/agent/sessions/:sessionId/run` 接受用户输入和受限上下文。
- BFF 运行 harness，并只返回最终输出或待执行的受控工具调用。
- 浏览器插件作为 Tool Host 执行白名单工具并将结果提交回 BFF；BFF 不执行浏览器 API。

## 两种接入形态

### Cloudflare 项目

`dataAnalyzeProject` 一类项目在 Worker 中创建 Cloudflare runtime，Key 仍由 Worker Secret 管理，D1 管理 context。业务代码只注册自己的工具与 prompt。

### 无 Secret 能力的前端项目

`BOOS_browser_ext` 一类项目额外部署其项目专属 BFF。扩展仅采集业务信息、请求 BFF，并按白名单执行浏览器工具；BFF 通过 SQLite adapter 调用 LLM。扩展移除 LLM Endpoint、模型和 API Key 设置项。

## 最小 Harness 协议

1. BFF/Worker 接收 `{ sessionId, input, context }`。
2. core 读取该 session 的受限历史，合成 `system prompt + history + input`。
3. LLM 返回文本或结构化工具调用。
4. 若为工具调用，校验工具名、输入 Zod Schema、最大步数和权限。
5. 在同一运行时执行服务端工具，或返回 `pending_tool_call` 由远端 Tool Host 执行。
6. 工具结果写入 context，再进入下一轮；达到 `maxSteps` 返回 `HARNESS_STEP_LIMIT`。

## 非目标

- 第一版不实现多 Agent、向量数据库、RAG、自动工具发现、任意代码执行或跨项目共享业务数据库。
- 第一版不兼容浏览器 localStorage API Key。
- 第一版不替换现有项目全部业务 Prompt；迁移按单一调用点逐步进行。

## 验收标准

- core 可在 Node 单测中用 fake fetch 与内存 session store 跑通文本输出、服务端工具调用、远端工具挂起和最大步数失败。
- Cloudflare adapter 使用 mock Env/D1 验证只从指定 Binding 读取配置。
- SQLite adapter 验证数据库中没有可检索的明文 API Key，且缺少主密钥或密钥记录时失败。
- Hono BFF 验证未鉴权请求被拒绝，且响应/日志不包含密钥与原始 Prompt。
