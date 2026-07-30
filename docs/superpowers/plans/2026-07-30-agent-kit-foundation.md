# Agent Kit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可发布的 TypeScript workspace，提供安全的 LLM core、Cloudflare 与 SQLite 适配器，以及可供浏览器插件接入的 Hono BFF。

**Architecture:** `@agent-kit/core` 只定义 LLM、Prompt、context、工具和 harness 契约。Cloudflare 与 SQLite 包分别实现密钥和 session 存储；BFF 包把 core harness 暴露为鉴权 HTTP 协议，浏览器仅作为受限 Tool Host。

**Tech Stack:** Node.js 22、pnpm 11、TypeScript、Zod、Vitest、Hono、Cloudflare Workers Types、Node `node:sqlite`、Web Crypto AES-GCM。

## Global Constraints

- 浏览器、扩展与 H5 不得接收、存储或直连使用 LLM API Key。
- 缺少密钥返回 `SECRET_NOT_CONFIGURED`，不得从 localStorage、明文文件或默认值读取。
- 日志不得包含 API Key、Prompt 正文、模型原文或业务上下文。
- 所有业务函数、变量和复杂控制流必须有中文注释。
- core 不依赖 Cloudflare、SQLite 或 Hono。

---

### Task 1: 初始化 workspace 与发布边界

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/adapter-cloudflare/package.json`
- Create: `packages/adapter-sqlite/package.json`
- Create: `packages/bff-hono/package.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces：包名 `@agent-kit/core`、`@agent-kit/adapter-cloudflare`、`@agent-kit/adapter-sqlite`、`@agent-kit/bff-hono`。
- Produces：根命令 `pnpm typecheck`、`pnpm test`、`pnpm build`。

- [ ] **Step 1: 为 core 写入空导出测试**

```ts
import { describe, expect, it } from 'vitest'
import { AGENT_KIT_VERSION } from '../src/index.js'

describe('core package', () => {
  it('暴露运行时版本', () => {
    expect(AGENT_KIT_VERSION).toBe('0.1.0')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-kit/core test`

Expected: FAIL，原因是 package 与入口尚不存在。

- [ ] **Step 3: 创建 pnpm workspace 与统一 TypeScript 配置**

```json
{
  "name": "agent-kit",
  "private": true,
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": { "build": "pnpm -r build", "typecheck": "pnpm -r typecheck", "test": "pnpm -r test" }
}
```

为每个包创建 ESM `package.json` 与 `src/index.ts`，仅 core 导出 `AGENT_KIT_VERSION = '0.1.0'`；其它包暂不导出业务实现。

- [ ] **Step 4: 运行根校验**

Run: `pnpm install && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS，四个 workspace 包均能被 TypeScript 构建。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore packages
git commit -m "chore: initialize agent kit workspace"
```

### Task 2: 实现不含运行时依赖的 core

**Files:**
- Create: `packages/core/src/contracts.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/prompt-registry.ts`
- Create: `packages/core/src/context-manager.ts`
- Create: `packages/core/src/tool-registry.ts`
- Create: `packages/core/src/harness.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/harness.test.ts`

**Interfaces:**
- Consumes：`SecretProvider.get(): Promise<LlmSecret>`、`SessionStore.load(sessionId)` 与 `SessionStore.save(session)`。
- Produces：`createAgentHarness(deps).run({ sessionId, input, context })`。
- Produces：`ToolRegistry.register(definition)`，工具定义含 Zod 输入/输出 Schema 与 `execution: 'server' | 'remote'`。

- [ ] **Step 1: 写入 harness 失败测试**

```ts
it('服务端工具结果会进入下一次模型调用', async () => {
  const harness = createAgentHarness({ llm, prompts, sessions, tools, audit, maxSteps: 3 })
  const result = await harness.run({ sessionId: 's-1', input: '查询天气', context: {} })
  expect(result.type).toBe('final')
  expect(llm.requests).toHaveLength(2)
})

it('远端工具返回 pending_tool_call 且不执行工具', async () => {
  const result = await harness.run({ sessionId: 's-2', input: '读取页面', context: {} })
  expect(result).toMatchObject({ type: 'pending_tool_call', toolName: 'browser.read_page' })
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @agent-kit/core test -- harness.test.ts`

Expected: FAIL，原因是 `createAgentHarness` 尚未导出。

- [ ] **Step 3: 以最小契约实现 core**

```ts
export type HarnessResult =
  | { type: 'final'; output: unknown }
  | { type: 'pending_tool_call'; callId: string; toolName: string; input: unknown }

export interface AgentHarness {
  run(input: { sessionId: string; input: string; context: Record<string, unknown> }): Promise<HarnessResult>
  resume(input: { sessionId: string; callId: string; output: unknown }): Promise<HarnessResult>
}
```

工具调用前必须校验已注册工具、输入 Schema、`maxSteps`；工具结果必须校验输出 Schema。错误统一抛出带 `code` 的 `AgentKitError`，至少含 `SECRET_NOT_CONFIGURED`、`TOOL_NOT_REGISTERED`、`TOOL_INPUT_INVALID`、`TOOL_OUTPUT_INVALID`、`HARNESS_STEP_LIMIT`、`LLM_RESPONSE_INVALID`。

- [ ] **Step 4: 运行 core 校验**

Run: `pnpm --filter @agent-kit/core typecheck && pnpm --filter @agent-kit/core test`

Expected: PASS，覆盖文本完成、服务端工具、远端工具、输入无效、输出无效与步数上限。

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add context and tool harness"
```

### Task 3: 实现 Cloudflare 与 SQLite 运行时适配器

**Files:**
- Create: `packages/adapter-cloudflare/src/index.ts`
- Create: `packages/adapter-cloudflare/src/d1-session-store.ts`
- Create: `packages/adapter-cloudflare/src/cloudflare-secret-provider.ts`
- Test: `packages/adapter-cloudflare/src/index.test.ts`
- Create: `packages/adapter-sqlite/src/index.ts`
- Create: `packages/adapter-sqlite/src/sqlite-session-store.ts`
- Create: `packages/adapter-sqlite/src/sqlite-secret-provider.ts`
- Create: `packages/adapter-sqlite/src/schema.sql`
- Test: `packages/adapter-sqlite/src/sqlite-secret-provider.test.ts`

**Interfaces:**
- Consumes：core 的 `SecretProvider`、`SessionStore` 与 `LlmConfig`。
- Produces：`createCloudflareAgentRuntime(env, options)` 和 `createSqliteAgentRuntime(options)`。

- [ ] **Step 1: 写入适配器失败测试**

```ts
it('Cloudflare 只读取显式 Binding', async () => {
  await expect(createCloudflareAgentRuntime({ LLM_API_KEY: '' }, options).secrets.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
})

it('SQLite 只保存密文，不保存 API Key 明文', async () => {
  await runtime.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://example.test/v1', model: 'test' })
  expect(runtime.databaseText()).not.toContain('sk-test-value')
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @agent-kit/adapter-cloudflare test && pnpm --filter @agent-kit/adapter-sqlite test`

Expected: FAIL，原因是两个 runtime factory 尚不存在。

- [ ] **Step 3: 实现两个适配器**

Cloudflare adapter 接收 `env` 与 `{ apiKeyBinding, baseUrlBinding, modelBinding, database }`；任一 Binding 为空即返回 `SECRET_NOT_CONFIGURED`。D1 建表保存 session 消息和更新时间。

SQLite adapter 使用 `node:sqlite`；`agent_secrets` 表仅保存 AES-GCM 的 `ciphertext`、`iv` 与 `key_version`，`agent_sessions` 表保存 JSON context。`AGENT_KIT_MASTER_KEY` 缺失、不是 32 字节 base64url 值或解密失败时均返回明确错误；不得生成临时主密钥。

- [ ] **Step 4: 运行适配器校验**

Run: `pnpm --filter @agent-kit/adapter-cloudflare typecheck && pnpm --filter @agent-kit/adapter-cloudflare test && pnpm --filter @agent-kit/adapter-sqlite typecheck && pnpm --filter @agent-kit/adapter-sqlite test`

Expected: PASS，密钥、加密存储、D1 session 与缺失配置分支均被覆盖。

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-cloudflare packages/adapter-sqlite
git commit -m "feat(adapters): add cloudflare and sqlite runtimes"
```

### Task 4: 实现 BFF 路由与远端工具协议

**Files:**
- Create: `packages/bff-hono/src/index.ts`
- Create: `packages/bff-hono/src/routes.ts`
- Create: `packages/bff-hono/src/auth.ts`
- Create: `packages/bff-hono/src/protocol.ts`
- Test: `packages/bff-hono/src/routes.test.ts`
- Create: `examples/browser-extension-bff/src/server.ts`
- Create: `examples/browser-extension-bff/README.md`

**Interfaces:**
- Consumes：`AgentHarness` 与 `authenticate(request): Promise<{ subject: string } | null>`。
- Produces：`createAgentBff({ harness, authenticate })`。
- Produces：`POST /v1/agent/sessions/:sessionId/run` 与 `POST /v1/agent/sessions/:sessionId/tool-results/:callId`。

- [ ] **Step 1: 写入 BFF 失败测试**

```ts
it('未鉴权请求返回 401', async () => {
  const response = await app.request('/v1/agent/sessions/s-1/run', { method: 'POST', body: JSON.stringify({ input: 'hi', context: {} }) })
  expect(response.status).toBe(401)
})

it('远端工具调用只返回白名单协议', async () => {
  const response = await app.request('/v1/agent/sessions/s-1/run', authenticatedRequest)
  await expect(response.json()).resolves.toMatchObject({ type: 'pending_tool_call', toolName: 'browser.read_page' })
})
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @agent-kit/bff-hono test -- routes.test.ts`

Expected: FAIL，原因是 `createAgentBff` 尚不存在。

- [ ] **Step 3: 实现 BFF 和 Tool Host 协议**

请求 body 严格为 `{ input: string, context: Record<string, unknown> }`。路由先调用 `authenticate`，然后把已认证 `subject` 绑定到 session namespace，防止跨用户读取 context。远端工具结果 body 严格为 `{ output: unknown }`，只允许回填当前 session 尚未完成的 callId。HTTP 错误只返回 `{ code, requestId, message }`。

- [ ] **Step 4: 运行 BFF 与根校验**

Run: `pnpm --filter @agent-kit/bff-hono typecheck && pnpm --filter @agent-kit/bff-hono test && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS，未授权、工具挂起、工具结果回填、跨 session callId 与敏感字段响应均被覆盖。

- [ ] **Step 5: Commit**

```bash
git add packages/bff-hono examples/browser-extension-bff
git commit -m "feat(bff): expose authenticated agent harness"
```

### Task 5: 编写接入文档与两个迁移示例

**Files:**
- Create: `README.md`
- Create: `docs/integrations/cloudflare-worker.md`
- Create: `docs/integrations/browser-extension-bff.md`
- Create: `docs/security.md`
- Test: `README.md` 命令块人工验证

**Interfaces:**
- Consumes：四个 package 的公开 API。
- Produces：dataAnalyzeProject Worker 接入示例与 BOOS 浏览器扩展+BFF 接入示例。

- [ ] **Step 1: 写入文档验收清单**

```markdown
- [ ] Cloudflare 示例未向前端暴露 `LLM_API_KEY`
- [ ] BFF 示例未在扩展配置中出现 Endpoint、模型或 API Key
- [ ] SQLite 示例要求设置 `AGENT_KIT_MASTER_KEY`
- [ ] 工具示例声明 `execution: 'remote'`
```

- [ ] **Step 2: 检查验收清单初始失败**

Run: `rg -n 'LLM_API_KEY|AGENT_KIT_MASTER_KEY|execution' README.md docs/integrations docs/security.md`

Expected: FAIL，文档尚不存在。

- [ ] **Step 3: 编写最小接入文档**

Cloudflare 文档展示 Worker `env` Binding、D1 migration 和 `createCloudflareAgentRuntime`。BFF 文档展示仅在 BFF 环境设置主密钥、SQLite 初始化、扩展调用 BFF 以及远端工具白名单。安全文档写明轮换 API Key 与主密钥的步骤，以及禁止记录的字段。

- [ ] **Step 4: 运行文档和完整验证**

Run: `rg -n 'localStorage|llmApiKey|Authorization: Bearer' docs README.md examples || true && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS；文档不得建议浏览器保存 API Key，完整 workspace 校验通过。

- [ ] **Step 5: Commit**

```bash
git add README.md docs examples
git commit -m "docs: add runtime integration guides"
```
