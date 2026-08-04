# Cloudflare Worker 接入指南

适用于 `dataAnalyzeProject` 一类在 Cloudflare Worker 中运行的业务。API Key、Base URL 与模型名全部由 Worker Secret Binding 提供，D1 负责 session 持久化，前端不接触任何 LLM 配置。

## 1. 环境准备

在 `wrangler.jsonc` 中声明 Secret Binding 与 D1 数据库：

```jsonc
{
  "vars": {},
  "d1_databases": [
    { "binding": "AGENT_DB", "database_name": "agent-kit", "database_id": "<database-id>" }
  ]
}
```

通过 `wrangler secret put` 设置以下三个 Secret：

- `LLM_API_KEY`：模型服务 API Key
- `LLM_BASE_URL`：兼容 OpenAI Chat Completions 的 Base URL，例如 `https://api.example.com/v1`
- `LLM_MODEL`：模型名

## 2. D1 建表

执行一次 migration 创建 session 表：

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  messages TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

该表只保存受控的 session 消息 JSON，不保存任何密钥。

## 3. 组装 runtime

```ts
import { createCloudflareAgentRuntime } from '@agent-kit/adapter-cloudflare'

export default {
  async fetch(request: Request, env: Env) {
    const runtime = createCloudflareAgentRuntime(env, {
      apiKeyBinding: 'LLM_API_KEY',
      baseUrlBinding: 'LLM_BASE_URL',
      modelBinding: 'LLM_MODEL',
      database: env.AGENT_DB,
      maxSteps: 5,
    })

    // 注册业务工具与系统提示词后运行 harness。
    runtime.tools.register({
      name: 'browser.read_page',
      execution: 'remote',
      input: z.object({ url: z.string() }),
      output: z.object({ title: z.string() }),
    })
    const result = await runtime.harness.run({ sessionId, input, context })
    return Response.json(result)
  },
}
```

`createCloudflareAgentRuntime` 返回 `{ secrets, sessions, tools, harness }`：

- `secrets.get()` 只从显式 Binding 名称读取，任一 Binding 为空即抛出 `SECRET_NOT_CONFIGURED`，不做任何回退。
- `harness.run()` 每次补全前重新读取当前 Binding，Secret 轮换无需重启 Worker。

## 4. 安全要点

- Worker 响应、日志与审计只记录 `requestId`、模型标识、耗时、HTTP 状态、工具名与错误码；不记录密钥、Prompt 正文、模型原文或业务上下文。
- 未配置密钥时直接返回 `SECRET_NOT_CONFIGURED`，不从其它来源探测。
