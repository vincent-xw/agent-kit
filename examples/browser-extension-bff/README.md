# browser-extension-bff 示例

为「无 Secret 能力的前端项目」提供的最小 Node BFF 示例：浏览器扩展只采集业务信息、请求 BFF，并按白名单执行远端工具；LLM API Key、Endpoint 与模型配置全部由 BFF 持有，扩展配置中不出现任何模型字段。

## 运行

```bash
pnpm install
export AGENT_KIT_MASTER_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
export BFF_API_TOKEN=your-bearer-token
pnpm --filter browser-extension-bff build
node packages/../examples/browser-extension-bff/dist/server.js
```

BFF 默认监听 `http://localhost:8787`。

## 协议

- `POST /v1/agent/sessions/:sessionId/run`，body 为 `{ "input": string, "context": Record<string, unknown> }`，携带 `Authorization: Bearer <BFF_API_TOKEN>`。
- 若响应为 `pending_tool_call`，扩展只能执行白名单中的远端工具，并把结果通过 `POST /v1/agent/sessions/:sessionId/tool-results/:callId`（body 为 `{ "output": unknown }`）回填。

## 安全要点

- 扩展移除 LLM Endpoint、模型与 API Key 设置项；密钥只由 BFF 进程环境持有。
- 主密钥（`AGENT_KIT_MASTER_KEY`）必须为 32 字节 base64url 值，只用于 AES-256-GCM 加解密，不写入 SQLite。
- 日志不得包含密钥、Prompt 正文、模型原文或业务上下文。
