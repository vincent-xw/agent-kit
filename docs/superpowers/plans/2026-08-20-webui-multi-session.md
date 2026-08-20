# WebUI 多会话管理与时序渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** flutter-dev-bff WebUI 支持多会话管理（左侧边栏）、按时间顺序渲染工具调用与 LLM 回复、一键复制完整上下文（Markdown 时序转录）、亮/暗主题切换。

**Architecture:** 方案 A「会话作用域事件 + 按序追加渲染」：core 契约新增可选字段（`sessionId`/`callId`/`turnId`）让事件携带会话身份；BFF 新增会话元数据表与 CRUD/导出端点；前端每会话一个 DOM 容器，事件按到达顺序 append，切换会话只切换容器显示。设计规格见 `docs/superpowers/specs/2026-08-20-webui-multi-session-design.md`。

**Tech Stack:** TypeScript（Node >=22）、pnpm workspace、vitest 3、Hono、原生 HTML/CSS/JS（无构建步骤）。

## Global Constraints

- 工作分支：`feature/webui-multi-session`（已创建，规格已提交）
- core 与 adapter-sqlite 的改动**只允许新增可选字段**，禁止修改既有字段语义——browser-extension-bff 必须零改动编译、零行为回归
- TypeScript strict 模式 + `noUncheckedIndexedAccess`（数组索引访问需非空断言）
- UI 文案全部中文
- 提交信息风格沿用仓库惯例：`feat: 中文描述`，末尾带 Co-Authored-By 行
- 单测命令：`pnpm --filter <pkg> test`；单文件：`pnpm --filter <pkg> exec vitest run <file>`
- 服务端工具事件载荷截断沿用 `truncate()`（2000 字符）；UI 卡片显示截断 500 字符
- 每个任务完成后跑该包全部测试再提交

---

### Task 1: core 契约字段与 harness 传递

**Files:**
- Modify: `packages/core/src/contracts.ts`（`ToolExecutionContext`，约 86-89 行）
- Modify: `packages/core/src/llm-client.ts`（`LlmDelta` 第 5-8 行、`LlmClientRequest` 第 45-54 行）
- Modify: `packages/core/src/harness.ts`（`executeWithTimeout` 第 85-103 行、`runLoop` 内 complete 调用与工具执行）
- Test: `packages/core/src/harness.test.ts`（追加用例）

**Interfaces:**
- Produces: `ToolExecutionContext { signal, sessionId?: string, callId?: string }`；`LlmClientRequest.sessionId?: string`；`LlmDelta { content?, reasoning?, sessionId?, turnId? }`。后续 Task 2/3 依赖 harness 已把这些值传到 llm 包装器与工具执行上下文。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/harness.test.ts` 的 `describe('AgentHarness', ...)` 内追加：

```ts
  it('服务端工具执行上下文携带 sessionId 与 callId', async () => {
    const contexts: Array<{ sessionId?: string; callId?: string }> = []
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async (_input, context) => {
        contexts.push(context)
        return { temperature: 26 }
      },
    })
    const requests: unknown[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-ctx', toolName: 'weather_read', input: {} })
            : { type: 'final', output: '完成' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })
    await harness.run({ sessionId: 's-ctx', input: '查询', context: {} })
    expect(contexts[0]).toMatchObject({ sessionId: 's-ctx', callId: 'call-ctx' })
  })

  it('LLM 补全请求携带 sessionId', async () => {
    const requests: Array<{ sessionId?: string }> = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return { type: 'final', output: '好的' }
        },
      },
      sessions: createMemorySessionStore(),
      tools: createToolRegistry(),
      maxSteps: 3,
    })
    await harness.run({ sessionId: 's-req', input: 'hi', context: {} })
    expect(requests[0]?.sessionId).toBe('s-req')
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @agent-kit/core exec vitest run src/harness.test.ts
```

预期：两个新用例 FAIL（`sessionId`/`callId` 为 undefined）。

- [ ] **Step 3: 实现**

`packages/core/src/contracts.ts` 的 `ToolExecutionContext` 改为：

```ts
/** 工具执行上下文：透传取消信号，使长时间运行的工具可被中止。 */
export interface ToolExecutionContext {
  signal: AbortSignal
  /** 本次调用所属会话，由 harness 注入；包装层可据此给事件标注会话。 */
  sessionId?: string
  /** 关联的调用 ID（与 tool 消息的 callId 对应），由 harness 注入。 */
  callId?: string
}
```

`packages/core/src/llm-client.ts` 的 `LlmDelta` 与 `LlmClientRequest`：

```ts
/** 流式增量回调的载荷。 */
export interface LlmDelta {
  content?: string
  reasoning?: string
  /** 由运行时注入：本次补全所属会话，供事件流按会话路由。 */
  sessionId?: string
  /** 由运行时注入：同一次补全内相同、跨次不同，前端据此分轮渲染。 */
  turnId?: string
}
```

```ts
/** 一次补全请求：input 为最新用户输入，messages 为会话历史，tools 为可调用工具声明。 */
export interface LlmClientRequest {
  input?: string
  context: Record<string, unknown>
  /** 发起本次补全的会话标识，由 harness 注入；运行时据此给流式回调标注会话。 */
  sessionId?: string
  messages: SessionMessage[]
  systemPrompt?: string
  /** 已注册工具的 JSON Schema 声明；为空或省略时不发送 tools 字段。 */
  tools?: ToolSchema[]
  /** 期望模型返回 JSON 对象；由 prompt 的输出协议声明驱动。 */
  responseFormatJson?: boolean
}
```

`packages/core/src/harness.ts`：`executeWithTimeout` 增加 `sessionId`/`callId` 参数并传入 context：

```ts
async function executeWithTimeout(
  tool: ToolDefinition,
  input: unknown,
  timeoutMs: number,
  sessionId: string,
  callId: string,
): Promise<unknown> {
  if (!tool.execute) throw new AgentKitError('TOOL_EXECUTOR_MISSING', `服务端工具缺少执行器：${tool.name}`)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await tool.execute(input, { signal: controller.signal, sessionId, callId })
  } catch (error) {
    if (timedOut) {
      throw new AgentKitError('TOOL_EXECUTION_TIMEOUT', `工具执行超时：${tool.name}`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
```

`runLoop` 内调用点（原 `rawOutput = await executeWithTimeout(tool, parsedInput, tool.timeoutMs ?? toolTimeoutMs)`）改为：

```ts
        rawOutput = await executeWithTimeout(tool, parsedInput, tool.timeoutMs ?? toolTimeoutMs, sessionId, call.callId)
```

`runLoop` 内 `deps.llm.complete` 调用在 `context,` 之后加一行 `sessionId,`：

```ts
        result = await deps.llm.complete({
          ...(pendingInput ? { input: pendingInput } : {}),
          context,
          sessionId,
          messages: trimHistory(sessionId, history),
          ...(prompt?.prompt ? { systemPrompt: prompt.prompt } : {}),
          ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
          ...(prompt?.protocol ? { responseFormatJson: true } : {}),
        })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @agent-kit/core test
```

预期：全部 PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/contracts.ts packages/core/src/llm-client.ts packages/core/src/harness.ts packages/core/src/harness.test.ts
git commit -m "$(cat <<'EOF'
feat: harness 传递 sessionId/callId 到工具执行上下文与 LLM 请求

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: adapter-sqlite 流式 delta 标注 turnId 与 sessionId

**Files:**
- Modify: `packages/adapter-sqlite/src/index.ts`（`createSqliteAgentRuntime` 内 llm 包装器，约 136-147 行）
- Test: `packages/adapter-sqlite/src/index.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `LlmClientRequest.sessionId`、`LlmDelta.sessionId/turnId`。
- Produces: 每次 `complete` 的所有 delta 都带 `{ sessionId, turnId }`；同一次 complete 内 turnId 相同、跨次不同。flutter-dev-bff 的 `llmDelta` 回调把这些字段展开进 `llm_delta` 事件。

- [ ] **Step 1: 写失败测试**

在 `packages/adapter-sqlite/src/index.test.ts` 末尾追加（该文件已有 `afterEach(() => vi.unstubAllGlobals())` 与 `validMasterKey` 常量）：

```ts
describe('SQLite runtime 流式 delta 标注', () => {
  it('delta 携带 sessionId 且每次补全 turnId 不同', async () => {
    const database = new DatabaseSync(':memory:')
    const deltas: Array<{ content?: string; sessionId?: string; turnId?: string }> = []
    const runtime = createSqliteAgentRuntime({
      database,
      masterKey: validMasterKey,
      maxSteps: 3,
      llmDelta: (delta) => deltas.push(delta),
    })
    await runtime.secrets.put({ apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `回复${call}` } }] }) }
    }))
    await runtime.harness.run({ sessionId: 's-delta', input: '一', context: {} })
    await runtime.harness.run({ sessionId: 's-delta', input: '二', context: {} })
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toMatchObject({ content: '回复1', sessionId: 's-delta' })
    expect(deltas[1]).toMatchObject({ content: '回复2', sessionId: 's-delta' })
    expect(deltas[0]!.turnId).toBeTruthy()
    expect(deltas[0]!.turnId).not.toBe(deltas[1]!.turnId)
    database.close()
  })
})
```

说明：llm-client 的非流式 fallback（响应 content-type 非 `text/event-stream` 且结果为 final 文本时会整体回调一次 onDelta，见 `llm-client.ts` completeStream 的 fallback 分支）让本测试无需构造 SSE 流。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @agent-kit/adapter-sqlite exec vitest run src/index.test.ts
```

预期：新用例 FAIL（`sessionId` 为 undefined）。

- [ ] **Step 3: 实现**

`packages/adapter-sqlite/src/index.ts` 中 `createSqliteAgentRuntime` 的 llm 包装器改为：

```ts
    llm: {
      complete: async (request) => {
        const secret = await secrets.get()
        // turnId 在每次补全开头生成：同一次补全的 delta 分轮渲染依据，跨次必然不同。
        const turnId = `turn-${Math.random().toString(36).slice(2, 10)}`
        return createLlmClient({
          ...secret,
          ...(options.llmTrace ? { trace: options.llmTrace } : {}),
          ...(options.llmDelta
            ? { onDelta: (delta) => options.llmDelta?.({ ...delta, sessionId: request.sessionId, turnId }) }
            : {}),
          ...(options.llmMaxRetries !== undefined ? { maxRetries: options.llmMaxRetries } : {}),
        }).complete(request)
      },
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @agent-kit/adapter-sqlite test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/adapter-sqlite/src/index.ts packages/adapter-sqlite/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: LLM 流式 delta 携带 sessionId 与 turnId

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: flutter-dev-bff 工具事件携带 sessionId 与 callId

**Files:**
- Modify: `examples/flutter-dev-bff/src/tool-events.ts`（`instrumentTools`，约 16-50 行）
- Test: `examples/flutter-dev-bff/src/tool-events.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `ToolExecutionContext.sessionId/callId`（harness 已传入）。
- Produces: `tool_start`/`tool_end` 事件含 `sessionId`、`callId` 字段。`FlutterEvent` 有索引签名 `[key: string]: unknown`，新字段类型兼容。

- [ ] **Step 1: 写失败测试**

在 `examples/flutter-dev-bff/src/tool-events.test.ts` 追加（文件已有 `collect`/`wrapOne`/`okTool`/`signal` 辅助）：

```ts
describe('instrumentTools 会话标注', () => {
  it('tool_start/tool_end 携带 context 的 sessionId 与 callId', async () => {
    const bus = createEventBus()
    const events = collect(bus)
    const wrapped = wrapOne(okTool, bus)
    await wrapped.execute!({ q: 'x' }, { signal: signal(), sessionId: 's-evt', callId: 'c-9' })
    expect(events[0]).toMatchObject({ type: 'tool_start', sessionId: 's-evt', callId: 'c-9' })
    expect(events[1]).toMatchObject({ type: 'tool_end', ok: true, sessionId: 's-evt', callId: 'c-9' })
  })

  it('无 sessionId 时不添加字段（兼容直接调用）', async () => {
    const bus = createEventBus()
    const events = collect(bus)
    const wrapped = wrapOne(okTool, bus)
    await wrapped.execute!({ q: 'x' }, { signal: signal() })
    expect(events[0]).not.toHaveProperty('sessionId')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/tool-events.test.ts
```

预期：第一个新用例 FAIL。

- [ ] **Step 3: 实现**

`examples/flutter-dev-bff/src/tool-events.ts` 的 `instrumentTools` 改为：

```ts
export function instrumentTools(definitions: ToolDefinition[], bus: EventBus): ToolDefinition[] {
  return definitions.map((definition) => {
    const original = definition.execute
    if (!original) return definition
    return {
      ...definition,
      execute: async (input, context) => {
        bus.emit({
          type: 'tool_start',
          name: definition.name,
          input: truncate(input),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.callId ? { callId: context.callId } : {}),
        })
        const startedAt = Date.now()
        try {
          const output = await original(input, context)
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: true,
            durationMs: Date.now() - startedAt,
            output: truncate(output),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.callId ? { callId: context.callId } : {}),
          })
          return output
        } catch (error) {
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.callId ? { callId: context.callId } : {}),
          })
          // 必须原样抛出：harness 会捕获工具错误并转成 ok:false 结果回传给模型，
          // 改变异常类型会干扰该机制。
          throw error
        }
      },
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/tool-events.test.ts src/server.test.ts src/sse.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/tool-events.ts examples/flutter-dev-bff/src/tool-events.test.ts
git commit -m "$(cat <<'EOF'
feat: 工具事件携带 sessionId 与 callId

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: webui_sessions 表与会话 CRUD API

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`（建表 + 4 个路由，插在现有 `/api/sessions/:sessionId/messages` 路由附近）
- Test: `examples/flutter-dev-bff/src/server.test.ts`（追加 describe）

**Interfaces:**
- Produces:
  - `GET /api/sessions` -> `{ sessions: Array<{ id: string; title: string; updatedAt: string }> }`（按 updatedAt 倒序，updatedAt 取 `agent_sessions` 活动时间与元数据时间的较大者）
  - `POST /api/sessions` body `{ id?: string; title?: string }` -> `{ id, title }`（id 可选、须匹配 `/^[\w-]+$/`，冲突返回 409；title 默认「新会话」、最长 60 字符）
  - `PATCH /api/sessions/:id` body `{ title: string }` -> `{ ok: true }`（404 不存在）
  - `DELETE /api/sessions/:id` -> `{ ok: true }`（同时删 `webui_sessions` 行与 `agent_sessions` 的 `flutter-dev:<id>` 行）
- 前端（Task 8）依赖这些端点管理边栏。

- [ ] **Step 1: 写失败测试**

在 `examples/flutter-dev-bff/src/server.test.ts` 末尾追加（文件已有 `bff()`/`run()` 辅助）：

```ts
describe('WebUI 会话管理', () => {
  const auth = { 'content-type': 'application/json', authorization: 'Bearer token-1' }

  it('未鉴权返回 401', async () => {
    const { app, database } = await bff()
    for (const [method, path] of [['GET', '/api/sessions'], ['POST', '/api/sessions'], ['DELETE', '/api/sessions/x']] as const) {
      const res = await app.request(path, { method })
      expect(res.status).toBe(401)
    }
    database.close()
  })

  it('创建/列表/重命名/删除会话，删除同时清理 agent_sessions', async () => {
    const { app, database } = await bff()
    const created = await (await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({}) })).json() as { id: string }
    expect(created.id).toMatch(/^sess-/)

    // 首条消息自动命名走同一 PATCH
    const patched = await app.request(`/api/sessions/${created.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: '首页调试' }) })
    expect(patched.status).toBe(200)

    // 有活动的会话排在前面：先给会话 A 写历史，再建会话 B
    database.prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run(`flutter-dev:${created.id}`, '[]', new Date().toISOString())
    const b = await (await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({}) })).json() as { id: string }

    const list = await (await app.request('/api/sessions', { headers: auth })).json() as { sessions: Array<{ id: string; title: string }> }
    expect(list.sessions).toHaveLength(2)
    expect(list.sessions[0]).toMatchObject({ id: created.id, title: '首页调试' })
    expect(list.sessions[1]).toMatchObject({ id: b.id, title: '新会话' })

    await app.request(`/api/sessions/${created.id}`, { method: 'DELETE', headers: auth })
    expect(database.prepare('SELECT COUNT(*) AS n FROM webui_sessions WHERE session_id = ?').get(created.id)).toMatchObject({ n: 0 })
    expect(database.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE session_id = ?').get(`flutter-dev:${created.id}`)).toMatchObject({ n: 0 })
    database.close()
  })

  it('POST 指定已存在 id 返回 409', async () => {
    const { app, database } = await bff()
    await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'legacy-1' }) })
    const res = await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'legacy-1' }) })
    expect(res.status).toBe(409)
    database.close()
  })

  it('PATCH 不存在的会话返回 404', async () => {
    const { app, database } = await bff()
    const res = await app.request('/api/sessions/nope', { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(404)
    database.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/server.test.ts
```

预期：新 describe FAIL（404 路由不存在）。

- [ ] **Step 3: 实现**

`examples/flutter-dev-bff/src/server.ts`：在 `const bus = createEventBus()` 之后建表：

```ts
  // WebUI 会话元数据：标题等纯展示信息；消息本体在 agent_sessions（前缀 flutter-dev:）
  database.exec(`CREATE TABLE IF NOT EXISTS webui_sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
```

在现有 `app.get('/api/sessions/:sessionId/messages', ...)` 路由之前插入四个路由（鉴权写法与该路由一致）：

```ts
  app.get('/api/sessions', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const rows = database.prepare(`
      SELECT w.session_id AS id, w.title AS title,
             COALESCE(a.updated_at, w.updated_at) AS updatedAt
      FROM webui_sessions w
      LEFT JOIN agent_sessions a ON a.session_id = 'flutter-dev:' || w.session_id
      ORDER BY updatedAt DESC
    `).all() as Array<{ id: string; title: string; updatedAt: string }>
    return c.json({ sessions: rows })
  })

  app.post('/api/sessions', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const body = await c.req.json<{ id?: unknown; title?: unknown }>().catch(() => ({}) as { id?: unknown; title?: unknown })
    const id = typeof body.id === 'string' && /^[\w-]+$/.test(body.id)
      ? body.id
      : 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    if (database.prepare('SELECT 1 FROM webui_sessions WHERE session_id = ?').get(id)) {
      return c.json({ error: 'session exists' }, 409)
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : '新会话'
    const now = new Date().toISOString()
    database.prepare('INSERT INTO webui_sessions (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now)
    return c.json({ id, title })
  })

  app.patch('/api/sessions/:sessionId', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown })
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({ error: 'title required' }, 400)
    const result = database
      .prepare('UPDATE webui_sessions SET title = ?, updated_at = ? WHERE session_id = ?')
      .run(body.title.trim().slice(0, 60), new Date().toISOString(), c.req.param('sessionId'))
    if (Number(result.changes) === 0) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  app.delete('/api/sessions/:sessionId', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('sessionId')
    database.prepare('DELETE FROM webui_sessions WHERE session_id = ?').run(id)
    database.prepare('DELETE FROM agent_sessions WHERE session_id = ?').run(`flutter-dev:${id}`)
    return c.json({ ok: true })
  })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter flutter-dev-bff test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat: WebUI 会话元数据表与 CRUD API

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 会话 Markdown 导出模块与端点

**Files:**
- Create: `examples/flutter-dev-bff/src/session-export.ts`
- Create: `examples/flutter-dev-bff/src/session-export.test.ts`
- Modify: `examples/flutter-dev-bff/src/server.ts`（导出路由，放在 `/api/sessions/:sessionId/messages` 之后）

**Interfaces:**
- Consumes: `SessionMessage`（`@agent-kit/core` 导出）。
- Produces: `renderSessionMarkdown(title: string, messages: SessionMessage[], toolOutputLimit: number): string`；`GET /api/sessions/:id/export?toolOutputLimit=N` 返回 `text/markdown`（N 缺省 20000，0=全量，非法值按 0 处理）。Task 8 的复制按钮依赖此端点。

- [ ] **Step 1: 写失败测试**

创建 `examples/flutter-dev-bff/src/session-export.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { renderSessionMarkdown } from './session-export.js'
import type { SessionMessage } from '@agent-kit/core'

const messages: SessionMessage[] = [
  { role: 'user', content: '启动应用' },
  { role: 'assistant', content: '我来启动应用', toolCalls: [{ callId: 'c1', toolName: 'flutter_run', input: { mode: 'run' } }] },
  { role: 'tool', content: { ok: true, deviceId: 'emu-1' }, callId: 'c1', toolName: 'flutter_run' },
  { role: 'assistant', content: '已启动' },
]

describe('renderSessionMarkdown', () => {
  it('按时间顺序渲染用户/助手/工具调用', () => {
    const md = renderSessionMarkdown('首页调试', messages, 20000)
    expect(md).toContain('# 会话: 首页调试')
    expect(md.indexOf('## 用户\n\n启动应用')).toBeGreaterThan(-1)
    expect(md.indexOf('## 助手\n\n我来启动应用')).toBeGreaterThan(-1)
    expect(md).toContain('## 工具调用: flutter_run')
    expect(md).toContain('"mode": "run"')
    expect(md).toContain('"ok": true')
    const order = [
      md.indexOf('## 用户'),
      md.indexOf('## 助手\n\n我来启动应用'),
      md.indexOf('## 工具调用: flutter_run'),
      md.indexOf('## 助手\n\n已启动'),
    ]
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1]!)
  })

  it('超过上限的工具输出截断并标注总长度', () => {
    const big: SessionMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 'big_tool', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(5000) }, callId: 'c1', toolName: 'big_tool' },
    ]
    const md = renderSessionMarkdown('t', big, 1000)
    expect(md).toContain('已截断，共 ')
    expect(md).not.toContain('x'.repeat(1500))
  })

  it('toolOutputLimit 为 0 不截断', () => {
    const big: SessionMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 'big_tool', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(5000) }, callId: 'c1', toolName: 'big_tool' },
    ]
    const md = renderSessionMarkdown('t', big, 0)
    expect(md).toContain('x'.repeat(5000))
  })

  it('未回填的调用输出标注无结果', () => {
    const md = renderSessionMarkdown('t', [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
    ], 20000)
    expect(md).toContain('（无结果）')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/session-export.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现模块**

创建 `examples/flutter-dev-bff/src/session-export.ts`：

```ts
import type { SessionMessage } from '@agent-kit/core'

/** 把会话历史渲染为时序 Markdown 转录。toolOutputLimit 为 0 表示不截断。 */
export function renderSessionMarkdown(title: string, messages: SessionMessage[], toolOutputLimit: number): string {
  const sections: string[] = [`# 会话: ${title}`]
  const outputs = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role === 'tool') outputs.set(message.callId, message.content)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      sections.push(`## 用户\n\n${typeof message.content === 'string' ? message.content : fencedJson(message.content)}`)
    } else if (message.role === 'assistant') {
      if (typeof message.content === 'string' && message.content.trim()) {
        sections.push(`## 助手\n\n${message.content}`)
      }
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          sections.push(toolCallSection(call.toolName, call.input, outputs.get(call.callId), toolOutputLimit))
        }
      }
    }
  }
  return sections.join('\n\n') + '\n'
}

function toolCallSection(toolName: string, input: unknown, output: unknown, toolOutputLimit: number): string {
  const parts = [`## 工具调用: ${toolName}`, '**输入**', fencedJson(input)]
  parts.push('**输出**')
  parts.push(output === undefined ? '（无结果）' : fencedJson(output, toolOutputLimit))
  return parts.join('\n\n')
}

function fencedJson(value: unknown, limit = 0): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = '[unserializable]'
  }
  if (limit > 0 && text.length > limit) {
    text = `${text.slice(0, limit)}…[已截断，共 ${text.length} 字符]`
  }
  return '```json\n' + text + '\n```'
}
```

- [ ] **Step 4: 跑模块测试确认通过**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/session-export.test.ts
```

预期：PASS。

- [ ] **Step 5: 写端点失败测试**

在 `examples/flutter-dev-bff/src/server.test.ts` 的 `describe('WebUI 会话管理', ...)` 内追加：

```ts
  it('export 端点返回 Markdown 转录', async () => {
    const { app, database } = await bff()
    await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'exp-1', title: '导出测试' }) })
    const history = [
      { role: 'user', content: '启动' },
      { role: 'assistant', content: '好的', toolCalls: [{ callId: 'c1', toolName: 'flutter_run', input: { mode: 'run' } }] },
      { role: 'tool', content: { ok: true }, callId: 'c1', toolName: 'flutter_run' },
      { role: 'assistant', content: '完成' },
    ]
    database.prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run('flutter-dev:exp-1', JSON.stringify(history), new Date().toISOString())

    const res = await app.request('/api/sessions/exp-1/export', { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const md = await res.text()
    expect(md).toContain('# 会话: 导出测试')
    expect(md).toContain('## 工具调用: flutter_run')
    expect(md).toContain('"ok": true')

    // 截断档位：toolOutputLimit=5 时长输出被截断
    database.prepare("UPDATE agent_sessions SET messages = ? WHERE session_id = 'flutter-dev:exp-1'").run(JSON.stringify([
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c2', toolName: 't', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(2000) }, callId: 'c2', toolName: 't' },
    ]))
    const truncated = await (await app.request('/api/sessions/exp-1/export?toolOutputLimit=5', { headers: auth })).text()
    expect(truncated).toContain('已截断，共 ')
    database.close()
  })
```

- [ ] **Step 6: 实现端点**

`examples/flutter-dev-bff/src/server.ts`：顶部 import 区加：

```ts
import { renderSessionMarkdown } from './session-export.js'
import type { SessionMessage } from '@agent-kit/core'
```

（`@agent-kit/core` 已有 type import 行，把 `SessionMessage` 加进那一行即可。）在 `/api/sessions/:sessionId/messages` 路由之后插入：

```ts
  // 一键复制上下文：服务端生成完整 Markdown 转录，与前端显示开关无关
  app.get('/api/sessions/:sessionId/export', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const rawLimit = c.req.query('toolOutputLimit')
    const toolOutputLimit = rawLimit === undefined ? 20000 : Math.max(0, Number(rawLimit) || 0)
    const id = c.req.param('sessionId')
    const scopedId = `flutter-dev:${id}`
    const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(scopedId) as { messages?: string } | undefined
    const messages: SessionMessage[] = row?.messages ? JSON.parse(row.messages) : []
    const meta = database.prepare('SELECT title FROM webui_sessions WHERE session_id = ?').get(id) as { title?: string } | undefined
    c.header('content-type', 'text/markdown; charset=utf-8')
    return c.body(renderSessionMarkdown(meta?.title ?? id, messages, toolOutputLimit))
  })
```

- [ ] **Step 7: 跑全部测试确认通过**

```bash
pnpm --filter flutter-dev-bff test
```

预期：全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/src/session-export.ts examples/flutter-dev-bff/src/session-export.test.ts examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat: 会话上下文 Markdown 导出端点

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: /assets 静态路由与主题变量表

**Files:**
- Create: `examples/flutter-dev-bff/public/assets/theme.css`
- Modify: `examples/flutter-dev-bff/src/server.ts`（静态资源路由）
- Test: `examples/flutter-dev-bff/src/server.test.ts`（追加 describe）

**Interfaces:**
- Produces: `GET /assets/<file>` 返回 `public/assets/` 下的 css/js（content-type 分别为 `text/css`/`text/javascript`，均带 charset）；文件名不匹配 `/^[\w.-]+$/` 或不存在返回 404。`theme.css` 定义两套 CSS 变量：`:root`（暗色，默认）与 `html[data-theme='light']`（亮色），变量名含应用侧 `--bg/--surface/--surface2/--text/--text2/--accent/--accent2/--error/--border/--tool-bg/--tool-border` 与文档侧 `--doc-bg/--doc-surface/--doc-surface2/--doc-text/--doc-text2/--doc-accent/--doc-accent2/--doc-border/--doc-code-bg`。Task 8/9 消费。

- [ ] **Step 1: 写失败测试**

在 `examples/flutter-dev-bff/src/server.test.ts` 末尾追加：

```ts
describe('静态资源路由', () => {
  it('GET /assets/theme.css 返回 css', async () => {
    const { app, database } = await bff()
    const res = await app.request('/assets/theme.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(await res.text()).toContain('--bg:')
    database.close()
  })

  it('路径穿越与不存在文件返回 404', async () => {
    const { app, database } = await bff()
    expect((await app.request('/assets/../src/server.ts')).status).toBe(404)
    expect((await app.request('/assets/nope.css')).status).toBe(404)
    database.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/server.test.ts
```

预期：新用例 FAIL。

- [ ] **Step 3: 创建 theme.css**

创建 `examples/flutter-dev-bff/public/assets/theme.css`：

```css
/* 主题变量：暗色为默认（与原配色一致），html[data-theme='light'] 覆盖为亮色。
   应用侧变量由 index.html/app.css 消费，--doc-* 由文档页 docs.css 消费。 */
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --surface2: #0f3460;
  --text: #e0e0e0;
  --text2: #a0a0b0;
  --accent: #4fc3f7;
  --accent2: #66bb6a;
  --error: #ef5350;
  --border: #2a2a4a;
  --tool-bg: #1e2a4a;
  --tool-border: #2a3a5a;
  --doc-bg: #0f1525;
  --doc-surface: #16213e;
  --doc-surface2: #1a2744;
  --doc-text: #e0e6f0;
  --doc-text2: #8a94a8;
  --doc-accent: #4fc3f7;
  --doc-accent2: #66bb6a;
  --doc-border: #2a3a5a;
  --doc-code-bg: #0a0f1c;
}

html[data-theme='light'] {
  --bg: #f4f6fb;
  --surface: #ffffff;
  --surface2: #e8eef7;
  --text: #1a2333;
  --text2: #5a6478;
  --accent: #0288d1;
  --accent2: #2e7d32;
  --error: #d32f2f;
  --border: #d7deeb;
  --tool-bg: #eef2fa;
  --tool-border: #dbe3f0;
  --doc-bg: #f7f9fc;
  --doc-surface: #ffffff;
  --doc-surface2: #eef2f8;
  --doc-text: #1a2333;
  --doc-text2: #5a6478;
  --doc-accent: #0288d1;
  --doc-accent2: #2e7d32;
  --doc-border: #dbe3f0;
  --doc-code-bg: #eef1f7;
}
```

- [ ] **Step 4: 实现静态路由**

`examples/flutter-dev-bff/src/server.ts`：在 DOC_PAGES 循环之后插入：

```ts
  // 静态资源：只允许 assets/ 下的扁平文件名（无斜杠即无路径穿越），按扩展名给 content-type
  app.get('/assets/*', (c) => {
    const rel = c.req.path.slice('/assets/'.length)
    if (!/^[\w.-]+$/.test(rel)) return c.notFound()
    const filePath = join(publicDir, 'assets', rel)
    if (!existsSync(filePath)) return c.notFound()
    const ext = rel.slice(rel.lastIndexOf('.') + 1)
    const contentType = ext === 'css' ? 'text/css; charset=utf-8' : ext === 'js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream'
    c.header('content-type', contentType)
    return c.body(readFileSync(filePath))
  })
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter flutter-dev-bff test
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add examples/flutter-dev-bff/public/assets/theme.css examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat: 静态资源路由与亮暗主题变量表

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: app.js 完整实现

**Files:**
- Create: `examples/flutter-dev-bff/public/assets/app.js`

**Interfaces:**
- Consumes: Task 4 的会话 CRUD、Task 5 的 export 端点、Task 3/2 事件携带的 `sessionId`/`callId`/`turnId`、既有 `/api/events`、`/v1/agent/sessions/:id/run|continue`、`/api/sessions/:id/messages`、`/api/skills*`、`/api/history`。
- Produces: 无外部消费者（浏览器脚本）。本任务只创建文件，旧 index.html 不引用它，页面行为不变；Task 8 切换 index.html 后生效。

**实现要点**（写代码时遵循）：
- 每个会话一个 `.session-messages` 容器 div（`views` Map 管理），当前会话加 `.active` 显示
- 事件按到达顺序 append 到对应容器末尾；`llm_delta` 按新 `turnId` 开新助手元素；工具卡片按 `callId` 索引
- 每容器记录 `lastSeq`，SSE 重连重放的 `seq <= lastSeq` 事件丢弃
- 「显示工具调用详情」只切 CSS class；复制走 export 端点，与显示无关

- [ ] **Step 1: 创建 app.js**

创建 `examples/flutter-dev-bff/public/assets/app.js`，内容如下（完整文件， Skills 面板部分自旧 `public/index.html` 原样迁移）：

```js
// Flutter Dev Agent WebUI：多会话管理 + 时序渲染
const TOKEN = localStorage.getItem('bff_token') || 'dev-token'
const $ = (id) => document.getElementById(id)
const messagesEl = $('messages')
const statusEl = $('status')
const promptEl = $('prompt')
const inputEl = $('input')
const sendBtn = $('send')
const stopBtn = $('stop')

let sessions = []
let currentSessionId = null
let running = false
let stopRequested = false
let showToolDetails = localStorage.getItem('show_tool_details') === '1'

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function relativeTime(iso) {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

// ── 会话视图：每会话一个独立容器，切换只切显示，不销毁 DOM ──
const views = new Map()

function getView(sessionId) {
  let view = views.get(sessionId)
  if (!view) {
    const el = document.createElement('div')
    el.className = 'session-messages'
    messagesEl.appendChild(el)
    view = { el, loaded: false, lastSeq: 0, turns: new Map(), tools: new Map(), currentTurn: null, typingEl: null }
    views.set(sessionId, view)
  }
  return view
}

function showSession(sessionId) {
  for (const [sid, view] of views) view.el.classList.toggle('active', sid === sessionId)
}

// ── 会话列表与边栏 ──
async function refreshSessions() {
  try {
    const data = await api('/api/sessions')
    sessions = data.sessions || []
  } catch {
    sessions = []
  }
  renderSessionList()
}

function renderSessionList() {
  $('session-list').innerHTML = sessions.map((s) => `
    <div class="session-item${s.id === currentSessionId ? ' active' : ''}" data-id="${escapeHtml(s.id)}">
      <div class="session-title">${escapeHtml(s.title)}</div>
      <div class="session-time">${escapeHtml(relativeTime(s.updatedAt))}</div>
      <span class="activity-dot" data-dot="${escapeHtml(s.id)}"></span>
      <button class="session-delete" title="删除会话">✕</button>
    </div>`).join('')
}

async function createSession() {
  const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) })
  await refreshSessions()
  return data.id
}

async function switchSession(sessionId) {
  currentSessionId = sessionId
  localStorage.setItem('flutter_session_id', sessionId)
  renderSessionList()
  showSession(sessionId)
  const view = getView(sessionId)
  if (!view.loaded) {
    view.loaded = true
    await restoreHistory(sessionId, view)
  }
  inputEl.focus()
}

async function renameSession(sessionId, title) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  await refreshSessions()
}

async function deleteSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId)
  if (!confirm(`确定删除会话「${s?.title ?? sessionId}」？会话历史将一并删除。`)) return
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  views.delete(sessionId)
  await refreshSessions()
  if (sessionId === currentSessionId) {
    const next = sessions[0]?.id ?? (await createSession())
    await switchSession(next)
  }
}

$('session-list').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item')
  if (!item) return
  if (e.target.closest('.session-delete')) { deleteSession(item.dataset.id); return }
  switchSession(item.dataset.id)
})

$('session-list').addEventListener('dblclick', (e) => {
  const item = e.target.closest('.session-item')
  if (item) startRename(item)
})

function startRename(item) {
  const id = item.dataset.id
  const titleEl = item.querySelector('.session-title')
  const old = titleEl.textContent
  titleEl.innerHTML = `<input class="rename-input" value="${escapeHtml(old)}">`
  const input = titleEl.querySelector('input')
  input.focus()
  input.select()
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
    if (e.key === 'Escape') { input.value = old; input.blur() }
  })
  input.addEventListener('blur', async () => {
    const v = input.value.trim()
    if (v && v !== old) await renameSession(id, v.slice(0, 60))
    else renderSessionList()
  }, { once: true })
}

$('new-session-btn').addEventListener('click', async () => {
  if (running) return
  const id = await createSession()
  await switchSession(id)
})

// ── 活动圆点：非当前会话收到事件时点亮 3 秒 ──
const dotTimers = new Map()

function touchActivityDot(sessionId) {
  const dot = document.querySelector(`[data-dot="${CSS.escape(sessionId)}"]`)
  if (!dot) return
  dot.classList.add('on')
  clearTimeout(dotTimers.get(sessionId))
  dotTimers.set(sessionId, setTimeout(() => dot.classList.remove('on'), 3000))
}

// ── Markdown 基础渲染 ──
function formatContent(text) {
  let html = escapeHtml(text)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\[截图\]\(screenshotId:([\w-]+)\)/g, '<img src="/api/screenshots/$1" alt="screenshot">')
  return html
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function appendUser(view, text) {
  const div = document.createElement('div')
  div.className = 'msg user'
  div.innerHTML = formatContent(text)
  view.el.appendChild(div)
  scrollBottom()
}

/** 新的 LLM 轮次：移除打字指示器，容器末尾新建助手消息元素。 */
function createTurn(view) {
  if (view.typingEl) { view.typingEl.remove(); view.typingEl = null }
  const el = document.createElement('div')
  el.className = 'msg assistant'
  view.el.appendChild(el)
  const turn = { el, buffer: '' }
  view.currentTurn = turn
  return turn
}

function setTyping(view, on) {
  if (on && !view.typingEl) {
    const el = document.createElement('div')
    el.className = 'msg assistant'
    el.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>'
    view.el.appendChild(el)
    view.typingEl = el
    scrollBottom()
  } else if (!on && view.typingEl) {
    view.typingEl.remove()
    view.typingEl = null
  }
}

function formatToolDetail(value) {
  if (value === undefined || value === null || value === '') return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > 500 ? text.slice(0, 500) + '…' : text
}

function renderToolCard(div, name, status, input, output, sourceBadge) {
  let html = `<div><span class="tool-name">${escapeHtml(name)}</span> ${sourceBadge || ''}<span class="tool-status">${escapeHtml(status)}</span></div>`
  const inputText = formatToolDetail(input)
  if (inputText) html += `<div class="tool-io"><div class="tool-io-label">输入</div><div class="tool-output">${escapeHtml(inputText)}</div></div>`
  const outputText = formatToolDetail(output)
  if (outputText) html += `<div class="tool-io"><div class="tool-io-label">输出</div><div class="tool-output">${escapeHtml(outputText)}</div></div>`
  div.innerHTML = html
  div.classList.toggle('compact', !showToolDetails)
}

/** 工具卡片：实时（tool_start）与历史还原共用。 */
function appendToolCard(view, callId, name, input, output, status) {
  const div = document.createElement('div')
  div.className = 'msg tool' + (showToolDetails ? '' : ' compact')
  // 输入保存在元素属性上：tool_end 重渲染状态与输出时保留输入区
  div._input = input ?? null
  renderToolCard(div, name, status, div._input, output)
  view.el.appendChild(div)
  if (callId) view.tools.set(callId, div)
  scrollBottom()
  return div
}

// ── 历史还原：首访会话时从服务端重建 ──
async function restoreHistory(sessionId, view) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
    const messages = data.messages || []
    const outputs = new Map()
    for (const m of messages) {
      if (m.role === 'tool' && m.callId) outputs.set(m.callId, m.content)
    }
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        appendUser(view, m.content)
      } else if (m.role === 'assistant') {
        if (typeof m.content === 'string' && m.content.trim()) {
          const turn = createTurn(view)
          turn.buffer = m.content
          turn.el.innerHTML = formatContent(m.content)
        }
        if (Array.isArray(m.toolCalls)) {
          for (const call of m.toolCalls) {
            appendToolCard(view, call.callId, call.toolName, call.input, outputs.get(call.callId), '历史')
          }
        }
      }
    }
    scrollBottom()
  } catch {
    // 会话无历史或服务不可达
  }
}

// ── SSE：事件按 sessionId 路由到对应容器 ──
function routeEvent(event, seq, render) {
  if (!event.sessionId) return
  touchActivityDot(event.sessionId)
  const view = views.get(event.sessionId)
  if (!view) return
  if (seq > 0 && seq <= view.lastSeq) return // 断线重连重放去重
  if (seq > view.lastSeq) view.lastSeq = seq
  render(view)
  scrollBottom()
}

function sourceBadgeOf(data) {
  if (data.name === 'mobile_snapshot' && data.ok && typeof data.output === 'string') {
    try {
      const parsed = JSON.parse(data.output)
      if (parsed.source === 'companion') return '<span class="source-badge companion">Companion</span>'
      if (parsed.source === 'uiautomator') return '<span class="source-badge">uiautomator</span>'
    } catch { /* 输出可能被截断 */ }
  }
  return ''
}

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`)

  es.addEventListener('tool_start', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      appendToolCard(view, data.callId, data.name, data.input, null, '执行中…')
    })
  })

  es.addEventListener('tool_end', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      const status = data.ok ? `完成 ${data.durationMs}ms` : `失败 ${data.durationMs}ms`
      const detail = data.ok ? data.output : data.error
      const card = data.callId ? view.tools.get(data.callId) : null
      if (card) {
        renderToolCard(card, data.name, status, card._input, detail, sourceBadgeOf(data))
      } else {
        appendToolCard(view, data.callId, data.name, null, detail, status)
      }
    })
  })

  es.addEventListener('llm_delta', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      if (!data.turnId) return
      let turn = view.turns.get(data.turnId)
      if (!turn) {
        turn = createTurn(view)
        view.turns.set(data.turnId, turn)
      }
      if (data.content) {
        turn.buffer += data.content
        turn.el.innerHTML = formatContent(turn.buffer)
      }
    })
  })

  es.onerror = () => {
    statusEl.textContent = running ? '思考中…（事件流重连中）' : '事件流重连中…'
  }
  es.onopen = () => {
    if (!running) statusEl.textContent = '就绪'
  }
}

// ── 发送与 run/continue 循环 ──
async function sendMessage(text) {
  if (running || !currentSessionId) return
  const sessionId = currentSessionId
  running = true
  stopRequested = false
  sendBtn.disabled = true
  stopBtn.classList.remove('hidden')
  statusEl.textContent = '思考中...'
  const view = getView(sessionId)
  appendUser(view, text)
  inputEl.value = ''
  inputEl.style.height = 'auto'
  setTyping(view, true)

  try {
    const body = {
      input: text,
      context: { timestamp: new Date().toISOString(), platform: 'android' },
      stepMode: true,
      ...(promptEl.value !== 'free-form' ? { promptName: promptEl.value } : {}),
    }
    let result = await fetch(`/v1/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }).then((r) => r.json())

    let stepCount = 0
    while (result.type === 'step_done') {
      if (stopRequested) break
      stepCount += 1
      statusEl.textContent = `思考中…（第 ${stepCount} 步）`
      result = await fetch(`/v1/agent/sessions/${sessionId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          context: { timestamp: new Date().toISOString(), platform: 'android' },
          // 关键：continue 时必须带上 promptName，否则会回退到默认提示词
          ...(promptEl.value !== 'free-form' ? { promptName: promptEl.value } : {}),
        }),
      }).then((r) => r.json())
    }

    if (result.type === 'final') {
      const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)
      const turn = view.currentTurn ?? createTurn(view)
      if (output && output.trim()) {
        turn.el.innerHTML = formatContent(output)
      } else if (!turn.buffer) {
        turn.el.innerHTML = '<span style="color:var(--text2)">执行完成（模型未返回文字总结）。</span>'
      }
      maybeAutoTitle(sessionId, text)
    } else if (result.code) {
      const turn = view.currentTurn ?? createTurn(view)
      turn.el.className = 'msg assistant error'
      turn.el.textContent = `错误: ${result.message || result.code}`
    } else if (stopRequested) {
      const turn = view.currentTurn ?? createTurn(view)
      if (!turn.buffer) turn.el.innerHTML = '<span style="color:var(--text2)">已停止。</span>'
    }
  } catch (err) {
    const turn = view.currentTurn ?? createTurn(view)
    turn.el.className = 'msg assistant error'
    turn.el.textContent = `请求失败: ${err.message}`
  } finally {
    setTyping(view, false)
    running = false
    stopRequested = false
    sendBtn.disabled = false
    stopBtn.classList.add('hidden')
    statusEl.textContent = '就绪'
    inputEl.focus()
  }
}

/** 首条消息后把「新会话」占位标题替换为消息摘要。 */
async function maybeAutoTitle(sessionId, firstMessage) {
  const s = sessions.find((x) => x.id === sessionId)
  if (!s || s.title !== '新会话') return
  try {
    await renameSession(sessionId, firstMessage.slice(0, 30))
  } catch {
    // 命名失败不影响会话
  }
}

// ── 输入区 ──
sendBtn.addEventListener('click', () => {
  const text = inputEl.value.trim()
  if (text) sendMessage(text)
})

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = inputEl.value.trim()
    if (text) sendMessage(text)
  }
})

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
})

stopBtn.addEventListener('click', () => { stopRequested = true })

$('docs-btn').addEventListener('click', () => {
  window.open('guide.html', '_blank', 'noopener')
})

// ── 一键复制上下文：服务端导出完整 Markdown，与显示开关无关 ──
$('copy-context-btn').addEventListener('click', async () => {
  const btn = $('copy-context-btn')
  try {
    const limit = localStorage.getItem('copy_tool_output_limit') ?? '20000'
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/export?toolOutputLimit=${limit}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await navigator.clipboard.writeText(await res.text())
    const old = btn.textContent
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = old }, 1500)
  } catch (e) {
    alert('复制失败: ' + e.message)
  }
})

// ── 设置面板 ──
const settingsOverlay = $('settings-overlay')
const showToolDetailsEl = $('setting-show-tool-details')
const themeEl = $('setting-theme')
const copyLimitEl = $('setting-copy-limit')

showToolDetailsEl.checked = showToolDetails
themeEl.value = localStorage.getItem('theme') || 'dark'
copyLimitEl.value = localStorage.getItem('copy_tool_output_limit') ?? '20000'

function applyToolDetailSetting() {
  for (const view of views.values()) {
    view.el.querySelectorAll('.msg.tool').forEach((el) => el.classList.toggle('compact', !showToolDetails))
  }
}

$('settings-btn').addEventListener('click', () => settingsOverlay.classList.add('open'))
$('settings-close').addEventListener('click', () => settingsOverlay.classList.remove('open'))
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open')
})

showToolDetailsEl.addEventListener('change', () => {
  showToolDetails = showToolDetailsEl.checked
  localStorage.setItem('show_tool_details', showToolDetails ? '1' : '0')
  applyToolDetailSetting()
})

themeEl.addEventListener('change', () => {
  document.documentElement.dataset.theme = themeEl.value
  localStorage.setItem('theme', themeEl.value)
})

copyLimitEl.addEventListener('change', () => {
  localStorage.setItem('copy_tool_output_limit', copyLimitEl.value)
})

// ── Skills 面板（自旧版 index.html 迁移，逻辑不变） ──
const skillsOverlay = $('skills-overlay')
const skillsBtn = $('skills-btn')
const skillsClose = $('skills-close')
const skillsContent = $('skills-content')
let currentSkillSlug = null

skillsBtn.addEventListener('click', () => { skillsOverlay.classList.add('open'); renderSkillList(); })
skillsClose.addEventListener('click', () => { skillsOverlay.classList.remove('open'); currentSkillSlug = null; })
skillsOverlay.addEventListener('click', (e) => {
  if (e.target === skillsOverlay) { skillsOverlay.classList.remove('open'); currentSkillSlug = null; }
})

document.querySelectorAll('#skills-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#skills-tabs .tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    const t = tab.getAttribute('data-tab')
    if (t === 'history') renderHistory()
    else renderSkillList()
  })
})

async function renderSkillList() {
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  let skills = []
  try {
    const data = await api('/api/skills')
    skills = data.skills || []
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
    return
  }
  let html = `
    <button class="btn-primary" id="new-skill-btn" style="padding:10px;border:none;border-radius:6px;cursor:pointer;font-size:13px;">+ 用大白话新建 Skill</button>
    <div style="height:8px"></div>`
  if (skills.length === 0) {
    html += `<div class="empty-state">还没有 Skill。<br>点上面的按钮，用大白话描述你想做的事，LLM 会帮你生成。</div>`
  } else {
    for (const s of skills) {
      html += `<div class="skill-card" data-slug="${escapeHtml(s.slug)}">
        <div class="skill-name">${escapeHtml(s.meta.name)}</div>
        <div class="skill-desc">${escapeHtml(s.meta.description || '无描述')}</div>
        <div class="skill-meta">
          <span>v${escapeHtml(s.meta.version)}</span>
          <span>${escapeHtml((s.meta.updatedAt || '').slice(0, 10))}</span>
        </div>
      </div>`
    }
  }
  skillsContent.innerHTML = html
  document.getElementById('new-skill-btn')?.addEventListener('click', renderNewSkillForm)
  skillsContent.querySelectorAll('.skill-card').forEach((card) => {
    card.addEventListener('click', () => renderSkillDetail(card.dataset.slug))
  })
}

function renderNewSkillForm() {
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <form id="new-skill-form">
      <h3>用大白话描述你想做什么</h3>
      <textarea id="intent-input" placeholder="例如：打开真实场景 Demo，用账号 13800138000 密码 test123 登录，验证码填 123456，进入第一个订单，打开帮助中心，在 H5 页面用 e2e_user / pass1234 登录"></textarea>
      <div id="generate-status"></div>
      <div class="form-actions">
        <button type="button" class="btn-secondary" id="cancel-skill-gen" style="padding:10px;border-radius:8px;cursor:pointer;font-size:14px;">取消</button>
        <button type="submit" class="btn-primary" id="generate-btn" style="padding:10px;border:none;border-radius:8px;cursor:pointer;font-size:14px;">生成 Skill</button>
      </div>
    </form>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('cancel-skill-gen').addEventListener('click', renderSkillList)
  document.getElementById('new-skill-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const intent = document.getElementById('intent-input').value.trim()
    if (!intent) return
    const statusEl = document.getElementById('generate-status')
    statusEl.innerHTML = '<div class="generating">LLM 正在生成，请稍候…</div>'
    document.getElementById('generate-btn').disabled = true
    try {
      const generated = await api('/api/skills/generate', { method: 'POST', body: JSON.stringify({ intent }) })
      renderSkillEdit(generated, true)
    } catch (e) {
      statusEl.innerHTML = `<div style="color:var(--error);font-size:12px;">生成失败：${escapeHtml(e.message)}</div>`
      document.getElementById('generate-btn').disabled = false
    }
  })
}

function renderSkillEdit(skill, isNew) {
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <h3 style="font-size:14px;margin:4px 0">${isNew ? '核验并保存 Skill' : '编辑 Skill'}</h3>
    <form id="skill-form">
      <label>名称（英文 kebab-case，用于目录名）</label>
      <input name="name" value="${escapeHtml(skill.slug)}" />
      <label>描述</label>
      <input name="description" value="${escapeHtml(skill.meta.description || '')}" />
      <label>系统提示词（可编辑）</label>
      <textarea name="prompt">${escapeHtml(skill.prompt)}</textarea>
      <div class="form-actions">
        <button type="button" class="btn-secondary" id="cancel-skill" style="padding:8px;border-radius:6px;cursor:pointer;">取消</button>
        <button type="submit" class="btn-primary" style="padding:8px;border:none;border-radius:6px;cursor:pointer;">${isNew ? '保存 Skill' : '更新'}</button>
      </div>
    </form>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('cancel-skill').addEventListener('click', renderSkillList)
  document.getElementById('skill-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const payload = {
      name: fd.get('name'),
      description: fd.get('description'),
      prompt: fd.get('prompt'),
    }
    const slug = fd.get('name')
    try {
      await api(`/api/skills/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify(payload) })
      renderSkillList()
    } catch (err) {
      alert('保存失败：' + err.message)
    }
  })
}

async function renderHistory() {
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  try {
    const data = await api('/api/history')
    if (!data.runs || data.runs.length === 0) {
      skillsContent.innerHTML = `<div class="empty-state">暂无执行记录。<br>创建并执行一个 Skill 后，这里会显示历史。</div>`
      return
    }
    skillsContent.innerHTML = data.runs.map((r) => `
      <div class="run-item" style="cursor:pointer" onclick="renderSkillDetail('${r.slug}')">
        <div><span class="run-status ${r.status}">${escapeHtml(r.status)}</span> ${escapeHtml(r.meta.name)}</div>
        <div class="run-time">${r.startedAt} ${r.summary ? '- ' + escapeHtml(r.summary.slice(0, 80)) : ''}</div>
      </div>
    `).join('')
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
  }
}

async function renderSkillDetail(slug) {
  currentSkillSlug = slug
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  let skill
  try {
    skill = await api(`/api/skills/${encodeURIComponent(slug)}`)
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
    return
  }
  const runsHtml = (skill.runs || []).length === 0
    ? '<div style="color:var(--text2);font-size:12px;">暂无执行记录</div>'
    : `<div class="runs-list">${skill.runs.map((r) => `
        <div class="run-item">
          <div class="run-status ${r.status}">${r.status === 'completed' ? '✓ 成功' : r.status === 'failed' ? '✗ 失败' : r.status}</div>
          <div class="run-time">${escapeHtml((r.finishedAt || r.startedAt || '').replace('T', ' ').slice(0, 19))}</div>
          ${r.summary ? `<div style="font-size:12px;margin-top:4px;">${escapeHtml(r.summary)}</div>` : ''}
        </div>`).join('')}</div>`
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <div class="skill-detail">
      <h3 style="font-size:15px;">${escapeHtml(skill.meta.name)}</h3>
      <div style="color:var(--text2);font-size:12px;">${escapeHtml(skill.meta.description || '')}</div>
      <div style="color:var(--text2);font-size:11px;">v${escapeHtml(skill.meta.version)} · ${escapeHtml((skill.meta.tools || []).join(', '))}</div>
      <button class="btn-primary" id="run-skill-btn" style="padding:10px;border:none;border-radius:6px;cursor:pointer;font-weight:600;">▶ 一键执行</button>
      <button class="btn-secondary" id="optimize-skill-btn" style="padding:6px;border-radius:6px;cursor:pointer;margin-top:6px;align-self:flex-start;">⟳ 优化 Skill</button>
      <div>
        <strong style="font-size:12px;">系统提示词</strong>
        <pre>${escapeHtml(skill.prompt)}</pre>
      </div>
      <div>
        <strong style="font-size:12px;">执行历史</strong>
        ${runsHtml}
      </div>
      <button class="btn-danger" id="delete-skill-btn" style="padding:6px;border-radius:6px;cursor:pointer;margin-top:8px;align-self:flex-start;">删除 Skill</button>
    </div>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('run-skill-btn').addEventListener('click', () => runSkill(slug, skill.meta.name))
  document.getElementById('optimize-skill-btn').addEventListener('click', async () => {
    const btn = document.getElementById('optimize-skill-btn')
    btn.textContent = '优化中…'
    btn.disabled = true
    try {
      const result = await api(`/api/skills/${encodeURIComponent(slug)}/optimize`, { method: 'POST' })
      if (!confirm(`优化分析：${result.analysis}\n\n新版本：${result.version}\n\n是否保存新提示词？\n\n${result.prompt.slice(0, 300)}…`)) return
      await api(`/api/skills/${encodeURIComponent(slug)}/apply`, {
        method: 'POST',
        body: JSON.stringify({ prompt: result.prompt, version: result.version }),
      })
      renderSkillDetail(slug)
    } catch (e) {
      alert('优化失败: ' + e.message)
    } finally {
      btn.textContent = '⟳ 优化 Skill'
      btn.disabled = false
    }
  })
  document.getElementById('delete-skill-btn').addEventListener('click', async () => {
    if (!confirm(`确定删除 Skill「${skill.meta.name}」？`)) return
    await api(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' })
    renderSkillList()
  })
}

async function runSkill(slug, name) {
  skillsOverlay.classList.remove('open')
  const skillPromptName = 'skill-' + slug
  if (!Array.from(promptEl.options).some((o) => o.value === skillPromptName)) {
    const opt = document.createElement('option')
    opt.value = skillPromptName
    opt.textContent = 'Skill: ' + name
    promptEl.appendChild(opt)
  }
  promptEl.value = skillPromptName
  inputEl.value = '开始执行'
  sendMessage('开始执行')
}

// ── 启动：加载会话 + 旧数据迁移 ──
/** 旧版只把会话 ID 存 localStorage，服务端无记录；有历史则补建。 */
async function migrateLegacySession(legacyId) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(legacyId)}/messages`)
    const firstUser = (data.messages || []).find((m) => m.role === 'user' && typeof m.content === 'string')
    if (!firstUser) return null
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ id: legacyId, title: firstUser.content.slice(0, 30) }) })
    await refreshSessions()
    return legacyId
  } catch {
    return null
  }
}

async function init() {
  await refreshSessions()
  const legacy = localStorage.getItem('flutter_session_id')
  let target = null
  if (legacy && sessions.some((s) => s.id === legacy)) {
    target = legacy
  } else if (legacy) {
    target = await migrateLegacySession(legacy)
  }
  if (!target) target = sessions[0]?.id ?? (await createSession())
  await switchSession(target)
  connectEvents()
}

init()
```

- [ ] **Step 2: 语法校验**

```bash
node --check examples/flutter-dev-bff/public/assets/app.js
```

预期：无输出（语法合法）。

- [ ] **Step 3: 提交**

```bash
git add examples/flutter-dev-bff/public/assets/app.js
git commit -m "$(cat <<'EOF'
feat: WebUI app.js（多会话边栏/时序渲染/SSE 路由/设置/复制/Skills）

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: index.html 新结构与 app.css

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`（整体重写为引用静态资源的结构）
- Create: `examples/flutter-dev-bff/public/assets/app.css`
- Test: `examples/flutter-dev-bff/src/server.test.ts`（更新 GET / 用例断言）

**Interfaces:**
- Consumes: Task 6 的 `/assets/theme.css` 与静态路由、Task 7 的 `app.js`。
- Produces: 页面结构含 `#sidebar`/`#session-list`/`#new-session-btn`（边栏）、`#messages`（容器宿主）、既有面板 ID 不变（app.js 依赖这些 ID）。

- [ ] **Step 1: 更新 GET / 测试断言**

`examples/flutter-dev-bff/src/server.test.ts` 中 `it('GET / 返回 HTML', ...)` 改为：

```ts
  it('GET / 返回新结构 HTML', async () => {
    const { app, database } = await bff()
    const res = await app.request('/')
    // public/index.html 可能不在 dist 旁边，但状态码不应是 500
    expect([200, 404]).toContain(res.status)
    if (res.status === 200) {
      const html = await res.text()
      expect(html).toContain('id="session-list"')
      expect(html).toContain('/assets/app.js')
    }
    database.close()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter flutter-dev-bff exec vitest run src/server.test.ts
```

预期：该用例 FAIL（旧 HTML 无 `session-list`）。

- [ ] **Step 3: 创建 app.css**

创建 `examples/flutter-dev-bff/public/assets/app.css`（原 index.html 内联样式迁移 + 边栏与会话列表新增样式；颜色全部走 theme.css 变量）：

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }

/* 布局：左侧会话边栏 + 右侧主区 */
#app { display: flex; height: 100vh; }
#sidebar { width: 240px; flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 12px; gap: 10px; }
#new-session-btn { padding: 10px; background: var(--accent); color: var(--bg); border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
#new-session-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#session-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.session-item { position: relative; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.session-item:hover { background: var(--tool-bg); }
.session-item.active { background: var(--surface2); }
.session-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
.session-time { font-size: 11px; color: var(--text2); margin-top: 2px; }
.activity-dot { position: absolute; top: 10px; right: 28px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent2); opacity: 0; transition: opacity 0.2s; }
.activity-dot.on { opacity: 1; }
.session-delete { display: none; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text2); font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.session-item:hover .session-delete { display: block; }
.session-delete:hover { color: var(--error); background: var(--tool-bg); }
.rename-input { width: 100%; background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; color: var(--text); font-size: 13px; padding: 2px 4px; font-family: inherit; }
.rename-input:focus { outline: none; }

#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
header { padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
header h1 { font-size: 16px; font-weight: 600; }
header .status { font-size: 12px; color: var(--text2); }
header .status.connected { color: var(--accent2); }

/* 消息区：滚动宿主 + 每会话一个容器 */
#messages { flex: 1; overflow-y: auto; }
.session-messages { display: none; flex-direction: column; gap: 12px; padding: 20px; }
.session-messages.active { display: flex; }
.msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; line-height: 1.6; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: var(--surface2); color: var(--text); border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.msg.tool { align-self: flex-start; background: var(--tool-bg); border: 1px solid var(--tool-border); border-radius: 8px; padding: 8px 12px; font-size: 13px; max-width: 90%; }
.msg.tool .tool-name { font-weight: 600; color: var(--accent); }
.msg.tool .tool-status { color: var(--text2); font-size: 12px; }
.source-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin: 0 6px; background: var(--border); color: var(--text2); vertical-align: middle; }
.source-badge.companion { background: var(--accent2); color: var(--bg); }
.tool-io { margin-top: 6px; }
.tool-io-label { color: var(--text2); font-size: 11px; margin-bottom: 2px; }
.msg.tool .tool-output { color: var(--text2); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
.msg.error { border-color: var(--error); color: var(--error); }
.msg img { max-width: 100%; border-radius: 8px; margin-top: 8px; }
.msg code { background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 3px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
.msg pre { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.msg pre code { background: none; padding: 0; }

#input-bar { padding: 16px 20px; background: var(--surface); border-top: 1px solid var(--border); display: flex; gap: 10px; }
#input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; color: var(--text); font-size: 14px; resize: none; min-height: 42px; max-height: 120px; font-family: inherit; }
#input:focus { outline: none; border-color: var(--accent); }
#send { padding: 8px 20px; background: var(--accent); color: var(--bg); border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
#send:disabled { opacity: 0.5; cursor: not-allowed; }
#stop { padding: 8px 20px; background: transparent; color: var(--error); border: 1px solid var(--error); border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.hidden { display: none !important; }
.typing { display: inline-flex; gap: 4px; }
.typing span { width: 6px; height: 6px; background: var(--text2); border-radius: 50%; animation: blink 1.4s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.prompt-select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; }

/* 设置 */
#settings-btn { background: transparent; color: var(--text2); border: none; cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 6px; line-height: 1; }
#settings-btn:hover { background: var(--tool-bg); color: var(--text); }
#settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: none; align-items: flex-start; justify-content: flex-end; }
#settings-overlay.open { display: flex; }
#settings-panel { width: 320px; max-width: 90vw; height: 100%; background: var(--surface); border-left: 1px solid var(--border); padding: 20px; overflow-y: auto; }
#settings-panel h2 { font-size: 16px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
#settings-panel h2 button { background: none; border: none; color: var(--text2); font-size: 20px; cursor: pointer; }
.setting-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border); }
.setting-row .label { font-size: 14px; }
.setting-row .desc { font-size: 12px; color: var(--text2); margin-top: 2px; }
.setting-select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; flex-shrink: 0; margin-left: 16px; }
.switch { position: relative; width: 40px; height: 22px; flex-shrink: 0; margin-left: 16px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider { position: absolute; inset: 0; background: var(--border); border-radius: 22px; cursor: pointer; transition: 0.2s; }
.switch .slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--text2); border-radius: 50%; transition: 0.2s; }
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(18px); background: var(--bg); }
.msg.tool.compact .tool-output, .msg.tool.compact .tool-io { display: none; }
.msg.tool.compact { padding: 4px 10px; font-size: 12px; opacity: 0.8; }

/* Skills 面板 */
#skills-btn { background: transparent; color: var(--text2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
#skills-btn:hover { border-color: var(--accent); color: var(--accent); }
#docs-btn { background: transparent; color: var(--text2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 16px; cursor: pointer; line-height: 1.2; }
#docs-btn:hover { border-color: var(--accent); color: var(--accent); }
#copy-context-btn { background: transparent; color: var(--text2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 14px; cursor: pointer; line-height: 1.2; }
#copy-context-btn:hover { border-color: var(--accent2); color: var(--accent2); }
#skills-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: none; align-items: flex-start; justify-content: flex-end; }
#skills-overlay.open { display: flex; }
#skills-panel { width: 420px; max-width: 92vw; height: 100%; background: var(--surface); border-left: 1px solid var(--border); padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
#skills-content { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#skills-panel h2 { font-size: 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
#skills-panel h2 button { background: none; border: none; color: var(--text2); font-size: 20px; cursor: pointer; }
#skills-tabs { display: flex; gap: 0; }
#skills-tabs .tab { padding: 4px 12px; cursor: pointer; font-size: 13px; border-radius: 6px 6px 0 0; color: var(--text2); }
#skills-tabs .tab.active { color: var(--text); background: var(--bg); }
.skill-card { background: var(--tool-bg); border: 1px solid var(--tool-border); border-radius: 8px; padding: 12px; cursor: pointer; transition: border-color 0.15s; }
.skill-card:hover { border-color: var(--accent); }
.skill-card .skill-name { font-weight: 600; color: var(--text); font-size: 14px; }
.skill-card .skill-desc { font-size: 12px; color: var(--text2); margin-top: 4px; }
.skill-card .skill-meta { font-size: 11px; color: var(--text2); margin-top: 6px; display: flex; gap: 8px; align-items: center; }
.skill-card .skill-meta .run-count { background: var(--surface2); padding: 1px 6px; border-radius: 10px; }
.skill-card .skill-actions { margin-top: 8px; display: flex; gap: 6px; }
.skill-card .skill-actions button { font-size: 11px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
.btn-primary { background: var(--accent); color: var(--bg); border: none; font-weight: 600; }
.btn-secondary { background: transparent; color: var(--text2); border: 1px solid var(--border); }
.btn-danger { background: transparent; color: var(--error); border: 1px solid var(--error); }
#skill-form { display: flex; flex-direction: column; gap: 10px; }
#skill-form label { font-size: 12px; color: var(--text2); }
#skill-form input, #skill-form textarea { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--text); font-size: 13px; font-family: inherit; }
#skill-form textarea { min-height: 180px; resize: vertical; font-family: 'SF Mono', monospace; font-size: 12px; line-height: 1.5; }
#skill-form .form-actions { display: flex; gap: 8px; margin-top: 4px; }
#skill-form .form-actions button { flex: 1; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
#intent-input { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; color: var(--text); font-size: 14px; width: 100%; flex: 1; min-height: 120px; font-family: inherit; resize: none; scrollbar-width: none; -ms-overflow-style: none; line-height: 1.6; }
#intent-input::-webkit-scrollbar { display: none; }
#intent-input:focus { outline: none; border-color: var(--accent); }
#new-skill-form { display: flex; flex-direction: column; flex: 1; gap: 12px; min-height: 0; }
#new-skill-form > .back { flex-shrink: 0; }
#new-skill-form h3 { flex-shrink: 0; font-size: 15px; margin: 4px 0; }
#new-skill-form .form-actions { display: flex; gap: 10px; margin-top: auto; padding-top: 8px; }
#new-skill-form .form-actions button { flex: 1; padding: 11px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
#generate-status { min-height: 20px; }
.empty-state { text-align: center; color: var(--text2); font-size: 13px; padding: 40px 20px; line-height: 1.8; }
.generating { color: var(--accent); font-size: 12px; text-align: center; padding: 12px; }
.skill-detail { display: flex; flex-direction: column; gap: 10px; }
.skill-detail .back, .back { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 0; text-align: left; flex-shrink: 0; align-self: flex-start; }
.back:hover { text-decoration: underline; }
.skill-detail pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 11px; max-height: 300px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.runs-list { font-size: 12px; }
.run-item { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 6px; }
.run-item .run-status { font-weight: 600; }
.run-item .run-status.completed { color: var(--accent2); }
.run-item .run-status.failed { color: var(--error); }
.run-item .run-time { color: var(--text2); font-size: 11px; }
```

- [ ] **Step 4: 重写 index.html**

`examples/flutter-dev-bff/public/index.html` 整体替换为（所有内联 CSS/JS 移除，结构对接 app.js 的 ID）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flutter Dev Agent</title>
<script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'</script>
<link rel="stylesheet" href="/assets/theme.css">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <button id="new-session-btn">＋ 新建会话</button>
    <div id="session-list"></div>
  </aside>
  <main id="main">
    <header>
      <h1>Flutter Dev Agent</h1>
      <select class="prompt-select" id="prompt">
        <option value="free-form">自由模式</option>
        <option value="debugging">调试模式</option>
        <option value="testing">测试模式</option>
      </select>
      <span class="status" id="status">就绪</span>
      <button id="skills-btn" title="Skills">Skills</button>
      <button id="docs-btn" title="文档">📖</button>
      <button id="copy-context-btn" title="复制上下文">📋</button>
      <button id="settings-btn" title="设置">⚙</button>
    </header>
    <div id="messages"></div>
    <div id="input-bar">
      <textarea id="input" rows="1" placeholder="输入指令，例如：启动应用并检查首页是否正常显示..." autofocus></textarea>
      <button id="send">发送</button>
      <button id="stop" class="hidden">停止</button>
    </div>
  </main>
</div>

<!-- Skills 面板 -->
<div id="skills-overlay">
  <div id="skills-panel">
    <h2><span id="skills-tabs"><span class="tab active" data-tab="skills">Skills</span><span class="tab" data-tab="history">历史</span></span> <button id="skills-close">×</button></h2>
    <div id="skills-content"></div>
  </div>
</div>

<!-- 设置面板 -->
<div id="settings-overlay">
  <div id="settings-panel">
    <h2>设置 <button id="settings-close">×</button></h2>
    <div class="setting-row">
      <div>
        <div class="label">显示工具调用详情</div>
        <div class="desc">关闭后只显示工具名和状态。仅影响显示，一键复制始终完整。</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="setting-show-tool-details">
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div>
        <div class="label">主题</div>
        <div class="desc">亮色或暗色配色，全部页面生效</div>
      </div>
      <select id="setting-theme" class="setting-select">
        <option value="dark">暗色</option>
        <option value="light">亮色</option>
      </select>
    </div>
    <div class="setting-row">
      <div>
        <div class="label">复制时工具输出上限</div>
        <div class="desc">一键复制上下文中每条工具输出的最大字符数</div>
      </div>
      <select id="setting-copy-limit" class="setting-select">
        <option value="0">全量</option>
        <option value="10000">10K</option>
        <option value="20000">20K</option>
        <option value="50000">50K</option>
      </select>
    </div>
  </div>
</div>

<script src="/assets/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter flutter-dev-bff test
```

预期：全部 PASS（含更新后的 GET / 用例）。

- [ ] **Step 6: 提交**

```bash
git add examples/flutter-dev-bff/public/index.html examples/flutter-dev-bff/public/assets/app.css examples/flutter-dev-bff/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat: WebUI 新布局（会话边栏）并切换到静态资源

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 文档页接入亮暗主题

**Files:**
- Modify: `examples/flutter-dev-bff/public/docs.css`（`:root` 颜色块改为只留 `--doc-radius`）
- Modify: `examples/flutter-dev-bff/public/guide.html`、`tools.html`、`skills.html`、`settings.html`、`companion.html`、`custom-tools.html`（各加主题脚本与 theme.css 链接）

**Interfaces:**
- Consumes: Task 6 的 `theme.css`（`--doc-*` 变量两套定义）。
- Produces: 文档页随 `localStorage.theme` 切换亮暗。

- [ ] **Step 1: docs.css 变量化**

`examples/flutter-dev-bff/public/docs.css` 开头的 `:root { ... }` 块（`--doc-bg` 到 `--doc-radius` 共 11 个变量）替换为：

```css
/* Flutter Dev BFF 文档主题 -- 颜色变量移至 /assets/theme.css（亮暗两套） */
:root {
  --doc-radius: 10px;
}
```

其余规则引用 `var(--doc-*)` 的地方不动（变量改由 theme.css 提供）。

- [ ] **Step 2: 六个文档页接入主题**

对 `guide.html`、`tools.html`、`skills.html`、`settings.html`、`companion.html`、`custom-tools.html` 各文件：找到 `<link rel="stylesheet" href="docs.css">` 这一行，在其**前面**插入两行：

```html
<script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'</script>
<link rel="stylesheet" href="/assets/theme.css">
```

- [ ] **Step 3: 语法与引用检查**

```bash
grep -c 'assets/theme.css' examples/flutter-dev-bff/public/guide.html examples/flutter-dev-bff/public/tools.html examples/flutter-dev-bff/public/skills.html examples/flutter-dev-bff/public/settings.html examples/flutter-dev-bff/public/companion.html examples/flutter-dev-bff/public/custom-tools.html
```

预期：每个文件输出 1。

- [ ] **Step 4: 提交**

```bash
git add examples/flutter-dev-bff/public/docs.css examples/flutter-dev-bff/public/guide.html examples/flutter-dev-bff/public/tools.html examples/flutter-dev-bff/public/skills.html examples/flutter-dev-bff/public/settings.html examples/flutter-dev-bff/public/companion.html examples/flutter-dev-bff/public/custom-tools.html
git commit -m "$(cat <<'EOF'
feat: 文档页接入亮暗主题切换

Co-Authored-By: Claude Haiku 4.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 全量回归与手动验证

**Files:**
- 无新增；如回归发现问题，修复后按所属任务范围补测试再提交。

- [ ] **Step 1: 全仓测试与类型检查**

```bash
pnpm -r build && pnpm -r test && pnpm -r typecheck
```

预期：core、adapter-sqlite、bff-hono、browser-extension-bff、flutter-dev-bff 全部通过（browser-extension-bff 全绿即兼容性回归通过）。

- [ ] **Step 2: 浏览器手动验证**

前置：`examples/flutter-dev-bff/.env` 已配置真实 LLM 密钥。启动：

```bash
pnpm dev:flutter
```

浏览器打开 `http://localhost:8788`，逐项验证（无 Android 设备时用「列出设备」等轻指令验证多轮工具链路）：

1. **多会话**：新建会话 A 发送含工具调用的指令，观察时序为 用户→助手文本→工具卡片→助手总结，各元素独立、顺序正确；运行中点「＋ 新建会话」切到 B，B 不出现 A 的输出、边栏 A 项亮活动圆点；切回 A 已渲染内容完整
2. **重命名**：双击标题改名，刷新页面后保留
3. **删除**：删除会话后列表消失（`agent_sessions` 由测试覆盖）
4. **历史还原**：刷新页面，当前会话按时间顺序完整还原，工具卡片含输入与输出
5. **复制**：精简模式（工具详情关闭）下复制，粘贴内容为完整 Markdown 转录（含工具输入输出 JSON）；设置切 10K 上限后复制，超长输出含「已截断，共 N 字符」
6. **主题**：设置切亮色，主界面与全部文档页变亮、刷新保持、切回暗色正常
7. **显示开关**：「显示工具调用详情」只影响卡片显示，不影响复制内容
8. **断线重连**：重启 BFF 进程，页面 EventSource 自动重连，事件不重复渲染
9. **停止**：发送长任务点停止，界面出现「已停止」，无内容丢失

- [ ] **Step 3: 收尾**

验证全部通过后走 finishing-a-development-branch 流程（向用户汇报并确认合并方式）。

---

## Self-Review 记录

- 规格覆盖：多会话（Task 4/7/8）、时序渲染（Task 1/2/3/7）、复制完整（Task 5/7）、主题（Task 6/8/9）、兼容性（Task 10）、旧数据迁移与重放去重（Task 7）——全部有对应任务
- 类型一致性：`ToolExecutionContext.sessionId/callId`、`LlmClientRequest.sessionId`、`LlmDelta.sessionId/turnId` 贯穿 Task 1→2→3；前端消费的字段名与后端事件字段一致（`sessionId`/`callId`/`turnId`/`seq`）
- 无占位符：所有代码步骤含完整代码

