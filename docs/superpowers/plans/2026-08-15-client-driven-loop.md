# 取消/中断与步数限制（客户端持有循环） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `execution: 'server'` 工具路径获得可中断能力：harness 在每一步（模型调用 + 该轮 server 工具执行完毕）后可返回 `step_done`，由客户端决定是否继续。取消即不再请求下一步，无需服务端中断在途异步循环。

**Architecture:** 给 `harness.run` 增加可选 `stepMode`。开启后，server 工具执行完的那一步先落库再返回 `{ type: 'step_done' }`。新增 `harness.continue` 推进下一步（可带注入消息），不调用方不需要 callId。默认不传 `stepMode` 时行为逐字节不变，浏览器插件路径零影响。

**Tech Stack:** TypeScript (ESM)、Zod、vitest 3.2.4、Hono 4.8.5

## Global Constraints

- 修改 `packages/core`、`packages/bff-hono`、`examples/flutter-dev-bff`。不得修改 `examples/browser-extension-bff`，也不得修改 `BOOS_browser_ext`。
- **默认行为必须逐字节不变。** 不传 `stepMode` 时，`run()` 的返回、落库时机、历史内容与现状完全一致（插件依赖此行为，见 [AGENTS.md](../../../AGENTS.md)）。
- `stepMode` 只影响 server 工具路径。remote 工具本来就每步返回 `pending_tool_calls`，其行为不变。
- `continue` 不要求 callId（区别于 `resume`）。
- 不实现「停止在途异步循环」。server 工具一旦开始执行就跑完；取消的粒度是「下一步」。
- 起点：agent-kit 187 个测试通过。每个任务结束时 `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。
- 本仓库 tsconfig 开启 `noUncheckedIndexedAccess`：数组下标与 `Map.get` 为 `T | undefined`。

### 已验证的前提（非推断）

完整的 server 工具轮次（assistant 带 toolCalls + 每个 callId 有对应 tool 结果）在再次 `run()` 时**不会**被 `sanitizeIncompleteRounds` 裁掉。已用临时测试验证：模型仍收到该轮历史。因此 `/continue` 不会静默丢失上一步。

---

## File Structure

- `packages/core/src/contracts.ts` — `HarnessResult` 增加 `| { type: 'step_done' }` 变体。
- `packages/core/src/harness.ts` — `AgentHarness.run` 请求增加 `stepMode?: boolean`；`AgentHarness` 接口增加 `continue(request)`；`runLoop` 增加 `stepMode` 参数；server 工具执行完且 `stepMode` 时落库并返回 `step_done`。
- `packages/core/src/harness.test.ts` — 新增 stepMode 与 continue 的测试。
- `packages/bff-hono/src/index.ts` — `/run` 接收并校验 `stepMode`；新增 `POST /v1/agent/sessions/:sessionId/continue`。
- `packages/bff-hono/src/index.test.ts`（若不存在则在现有测试文件中追加）— 新端点测试。
- `examples/flutter-dev-bff/src/server.ts` — 已有的 `/run` 透传无需改；新端点由 `createAgentBff` 自动提供。
- `examples/flutter-dev-bff/public/index.html` — 从「单个 fetch 等结果」改为循环驱动，加停止按钮与步数计数。

---

### Task 1: core 契约与 step_done 返回

**Files:**
- Modify: `packages/core/src/contracts.ts`（`HarnessResult` 类型）
- Modify: `packages/core/src/harness.ts`（接口、runLoop、run）
- Test: `packages/core/src/harness.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `HarnessResult` 新增变体 `{ type: 'step_done' }`。
  - `AgentHarness.run` 的请求类型新增可选 `stepMode?: boolean`。
  - `AgentHarness.continue(request: { sessionId: string; context?: Record<string, unknown>; input?: string; promptName?: string }): Promise<HarnessResult>`（本任务只在接口中声明，Task 2 实现）。

- [ ] **Step 1: 写失败的测试**

在 `packages/core/src/harness.test.ts` 末尾的最外层 `describe('AgentHarness', ...)` 内追加：

```ts
  describe('stepMode', () => {
    it('server 工具执行完一步后返回 step_done 并落库', async () => {
      let callCount = 0
      const tools = createToolRegistry()
      tools.register({
        name: 'ping',
        execution: 'server',
        input: z.object({}),
        output: z.object({ pong: z.boolean() }),
        execute: async () => {
          callCount += 1
          return { pong: true }
        },
      })
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async () =>
            callsOf({ callId: 'c-ping', toolName: 'ping', input: {} }),
        },
        sessions,
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({
        sessionId: 's-step',
        input: 'ping 一下',
        context: {},
        stepMode: true,
      })

      expect(result).toEqual({ type: 'step_done' })
      expect(callCount).toBe(1)
      // 关键：继续之前历史必须已落库，否则 continue 会丢这一步
      const stored = await sessions.load('s-step')
      expect(stored.some((m) => m.role === 'tool')).toBe(true)
      expect(stored.some((m) => m.role === 'assistant' && (m as { toolCalls?: unknown }).toolCalls)).toBe(true)
    })

    it('不传 stepMode 时行为不变，循环跑到 final', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'ping',
        execution: 'server',
        input: z.object({}),
        output: z.object({ pong: z.boolean() }),
        execute: async () => ({ pong: true }),
      })
      let responses = 0
      const harness = createAgentHarness({
        llm: {
          complete: async () => {
            responses += 1
            return responses === 1
              ? callsOf({ callId: 'c-ping', toolName: 'ping', input: {} })
              : { type: 'final', output: 'pong' }
          },
        },
        sessions: createMemorySessionStore(),
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({ sessionId: 's-normal', input: 'x', context: {} })

      expect(result).toEqual({ type: 'final', output: 'pong' })
      expect(responses).toBe(2)
    })

    it('stepMode 不影响 remote 工具（仍返回 pending_tool_calls）', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'remote_thing',
        execution: 'remote',
        input: z.object({}),
        output: z.object({}),
      })
      const harness = createAgentHarness({
        llm: {
          complete: async () =>
            callsOf({ callId: 'c-r', toolName: 'remote_thing', input: {} }),
        },
        sessions: createMemorySessionStore(),
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({
        sessionId: 's-remote',
        input: 'x',
        context: {},
        stepMode: true,
      })

      expect(result.type).toBe('pending_tool_calls')
    })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/core && pnpm vitest run src/harness.test.ts`
Expected: FAIL。`expect(result).toEqual({ type: 'step_done' })` 失败——当前 server 工具执行完直接进入下一轮循环，不会返回 `step_done`。

- [ ] **Step 3: 扩展 HarnessResult 类型**

在 `packages/core/src/contracts.ts` 找到 `HarnessResult`：

```ts
export type HarnessResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'pending_tool_calls'; calls: Array<{ callId: string; toolName: string; input: unknown }> }
```

改为：

```ts
export type HarnessResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'pending_tool_calls'; calls: Array<{ callId: string; toolName: string; input: unknown }> }
  | { type: 'step_done' }
```

- [ ] **Step 4: 扩展 AgentHarness 接口**

在 `packages/core/src/harness.ts` 的 `AgentHarness.run(request: { ... })` 中，在 `skipTools?: boolean` 之后加：

```ts
    /** 分步模式：每执行完一轮 server 工具即返回 step_done，由调用方推进。 */
    stepMode?: boolean
```

在 `resume(...)` 声明之后加 `continue` 声明（本任务只声明，Task 2 实现）：

```ts
  /**
   * 分步模式下推进下一步。不要求 callId（区别于 resume）。
   * input 可选：提供时作为中途注入的用户消息（steering）。
   */
  continue(request: {
    sessionId: string
    context?: Record<string, unknown>
    input?: string
    promptName?: string
  }): Promise<HarnessResult>
```

- [ ] **Step 5: runLoop 增加 stepMode 参数与返回点**

找到 `runLoop` 签名（约 143 行），在 `skipTools?: boolean` 后加参数：

```ts
    stepMode?: boolean,
```

找到 server 工具执行完后的 remote 检查（约 245-248 行）：

```ts
      if (remoteCalls.length > 0) {
        await deps.sessions.save(sessionId, history)
        return { type: 'pending_tool_calls', calls: remoteCalls }
      }
```

在该 `if` 块**之后**加：

```ts
      if (stepMode) {
        await deps.sessions.save(sessionId, history)
        return { type: 'step_done' }
      }
```

注意：这个 save 是必需的。当前 server 路径在工具执行完后不存盘（直接进入下一轮），而 stepMode 在此返回，若不存盘，下次 `continue` 从 store 读到的是旧历史，这一步的工具结果会丢失。

- [ ] **Step 6: run 透传 stepMode**

在 `run` 的实现中（约 296 行），把对 `runLoop` 的调用从：

```ts
      return runLoop(request.sessionId, request.input, request.context, history, request.promptName, request.skipTools)
```

改为：

```ts
      return runLoop(request.sessionId, request.input, request.context, history, request.promptName, request.skipTools, request.stepMode)
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd packages/core && pnpm vitest run src/harness.test.ts`
Expected: PASS，三个新测试全过。

- [ ] **Step 8: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功。测试数 187 + 3 = 190。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/contracts.ts packages/core/src/harness.ts packages/core/src/harness.test.ts
git commit -m "feat(core): run 支持 stepMode，server 工具执行完一步返回 step_done

开启后每轮 server 工具执行完毕先落库再返回，由调用方决定是否继续。
不传 stepMode 时行为逐字节不变——浏览器插件路径零影响。落库是必需的：
当前 server 路径执行完不存盘即进入下一轮，stepMode 在此返回若不存盘，
continue 会丢失这一步的工具结果。"
```

---

### Task 2: continue 方法实现

**Files:**
- Modify: `packages/core/src/harness.ts`（实现 `continue`，Task 1 只声明了接口）
- Test: `packages/core/src/harness.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `stepMode`、`step_done` 返回、`runLoop`。
- Produces: 可用的 `harness.continue(request)`。

`continue` 与 `run` 的区别：不做 `sanitizeIncompleteRounds`（stepMode 落库的历史是完整轮次，没有残破 assistant 消息），从 store 读历史后以空（或注入的）input 调 `runLoop`，且强制 `stepMode: true`。

- [ ] **Step 1: 写失败的测试**

在 `describe('stepMode')` 块内追加：

```ts
    it('continue 推进到下一步，可多次调用直到 final', async () => {
      const tools = createToolRegistry()
      let n = 0
      tools.register({
        name: 'inc',
        execution: 'server',
        input: z.object({}),
        output: z.object({ n: z.number() }),
        execute: async () => ({ n: ++n }),
      })
      let modelCalls = 0
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async () => {
            modelCalls += 1
            // 前两次模型都决定调工具，第三次给最终答案
            return modelCalls < 3
              ? callsOf({ callId: 'c-' + modelCalls, toolName: 'inc', input: {} })
              : { type: 'final', output: 'done' }
          },
        },
        sessions,
        tools,
        maxSteps: 10,
      })

      const first = await harness.run({ sessionId: 's-cont', input: '开始', context: {}, stepMode: true })
      expect(first).toEqual({ type: 'step_done' })

      const second = await harness.continue({ sessionId: 's-cont' })
      expect(second).toEqual({ type: 'step_done' })

      const third = await harness.continue({ sessionId: 's-cont' })
      expect(third).toEqual({ type: 'final', output: 'done' })

      // 工具被执行了两次（每次 step_done 之前一轮）
      expect(n).toBe(2)
    })

    it('continue 带 input 时作为中途注入消息并入历史', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'noop',
        execution: 'server',
        input: z.object({}),
        output: z.object({}),
        execute: async () => ({}),
      })
      const seenInputs: string[] = []
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async (req) => {
            // 记录发给模型的 user 消息
            for (const m of req.messages) {
              if ((m as { role: string }).role === 'user') {
                seenInputs.push(String((m as { content: unknown }).content))
              }
            }
            return { type: 'final', output: 'ok' }
          },
        },
        sessions,
        tools,
        maxSteps: 5,
      })

      await harness.run({ sessionId: 's-inj', input: '初始任务', context: {}, stepMode: true })
      await harness.continue({ sessionId: 's-inj', input: '换个方向' })

      expect(seenInputs).toContain('初始任务')
      expect(seenInputs).toContain('换个方向')
    })

    it('continue 在没有 stepMode 历史的会话上也能工作（防御性）', async () => {
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: { complete: async () => ({ type: 'final', output: '直接完成' }) },
        sessions,
        tools: createToolRegistry(),
        maxSteps: 3,
      })

      const result = await harness.continue({ sessionId: 's-empty' })
      expect(result).toEqual({ type: 'final', output: '直接完成' })
    })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/core && pnpm vitest run src/harness.test.ts`
Expected: FAIL。`harness.continue is not a function`（Task 1 只在接口声明，未实现）。

- [ ] **Step 3: 实现 continue**

在 `harness.ts` 的 `return { async run(request) { ... }, async resume(request) { ... } }` 中，`resume` 方法之后加：

```ts
    async continue(request) {
      const history: SessionMessage[] = [...(await deps.sessions.load(request.sessionId))]
      // 注意：不调用 sanitizeIncompleteRounds。
      // stepMode 落库的历史是完整的 server 工具轮次，不存在残破 assistant 消息；
      // 若此处裁剪，会把上一步的工具结果误删。
      return runLoop(
        request.sessionId,
        request.input ?? '',
        request.context ?? {},
        history,
        request.promptName,
        undefined,
        true, // 强制 stepMode
      )
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/core && pnpm vitest run src/harness.test.ts`
Expected: PASS，6 个 stepMode 测试全过。

- [ ] **Step 5: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功。测试数 190 + 3 = 193。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/harness.ts packages/core/src/harness.test.ts
git commit -m "feat(core): 实现 continue，分步模式下推进下一步

不要求 callId，区别于 resume。可选 input 作为中途注入消息（steering）。
continue 不做 sanitizeIncompleteRounds——stepMode 落库的是完整轮次，
裁剪反而会误删上一步工具结果。"
```

---

### Task 3: bff-hono 端点

**Files:**
- Modify: `packages/bff-hono/src/index.ts`（`/run` 透传 stepMode；新增 `/continue` 端点）
- Test: 现有 bff-hono 测试文件

**Interfaces:**
- Consumes: Task 1/2 的 `harness.run(..., stepMode)` 与 `harness.continue`。
- Produces: `POST /v1/agent/sessions/:sessionId/continue`，body `{ context?, input?, promptName? }`。

先确认现有测试文件名与 mock 模式。

- [ ] **Step 1: 写失败的测试**

在 `packages/bff-hono/src/index.test.ts` 顶部 import 中加入 `vi`：

```ts
import { describe, expect, it, vi } from 'vitest'
```

在 `describe('Agent BFF', ...)` 内追加：

```ts
  it('/run 接收 stepMode 并透传给 harness', async () => {
    const run = vi.fn(async () => ({ type: 'step_done' as const }))
    const app = createAgentBff({
      harness: { run, resume: vi.fn() } as unknown as AgentHarness,
      authenticate: async () => ({ subject: 'user-1' }),
    })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x', context: {}, stepMode: true }),
    })
    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ stepMode: true }))
  })

  it('stepMode 非布尔值返回 400', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => ({ subject: 'user-1' }) })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x', context: {}, stepMode: 'yes' }),
    })
    expect(response.status).toBe(400)
  })

  it('POST /continue 无 input 时推进下一步', async () => {
    const continueFn = vi.fn(async () => ({ type: 'step_done' as const }))
    const app = createAgentBff({
      harness: { run: vi.fn(), resume: vi.fn(), continue: continueFn } as unknown as AgentHarness,
      authenticate: async () => ({ subject: 'user-1' }),
    })
    const response = await app.request('/v1/agent/sessions/s-1/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: {} }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ type: 'step_done' })
    expect(continueFn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'user-1:s-1' }))
  })

  it('POST /continue 带 input 时透传注入消息', async () => {
    const continueFn = vi.fn(async () => ({ type: 'final', output: 'ok' }))
    const app = createAgentBff({
      harness: { run: vi.fn(), resume: vi.fn(), continue: continueFn } as unknown as AgentHarness,
      authenticate: async () => ({ subject: 'user-1' }),
    })
    await app.request('/v1/agent/sessions/s-1/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: {}, input: '换个方向' }),
    })
    expect(continueFn).toHaveBeenCalledWith(expect.objectContaining({ input: '换个方向' }))
  })

  it('POST /continue 鉴权失败返回 401', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => null })
    const response = await app.request('/v1/agent/sessions/s-1/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: {} }),
    })
    expect(response.status).toBe(401)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/bff-hono && pnpm vitest run`
Expected: FAIL。`/continue` 返回 404；stepMode 透传断言失败（`undefined`）。

- [ ] **Step 4: /run 校验并透传 stepMode**

在 `/run` 路由里，找到现有的 `skipTools` 校验之后，加：

```ts
      if (body.stepMode !== undefined && typeof body.stepMode !== 'boolean') {
        audit(requestId, 'run', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'stepMode 必须是布尔值' }, 400)
      }
```

在 `options.harness.run({ ... })` 调用中，`skipTools: body.skipTools === true ? true : undefined` 之后加：

```ts
        ...(body.stepMode === true ? { stepMode: true } : {}),
```

- [ ] **Step 5: 新增 /continue 端点**

在 `/run` 路由之后、`/tool-results`（即 `resume`）路由之前，插入：

```ts
  app.post('/v1/agent/sessions/:sessionId/continue', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) {
        audit(requestId, 'continue', startedAt, 'UNAUTHORIZED')
        return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await context.req.json<{ input?: unknown; context?: unknown; promptName?: unknown }>()
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }
      if (body.input !== undefined && (typeof body.input !== 'string' || !body.input.trim())) {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'input 若提供必须是非空字符串' }, 400)
      }
      if (body.promptName !== undefined && typeof body.promptName !== 'string') {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'promptName 必须是字符串' }, 400)
      }
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.continue({
        sessionId: scopedSessionId,
        context: body.context as Record<string, unknown>,
        ...(typeof body.input === 'string' ? { input: body.input } : {}),
        ...(body.promptName ? { promptName: body.promptName } : {}),
      })
      audit(requestId, `continue:${result.type}`, startedAt)
      return context.json(result)
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      audit(requestId, 'continue', startedAt, payload.code)
      options.audit?.log({ requestId, durationMs: 0, errorCode: payload.message })
      return context.json(payload, 500)
    }
  })
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/bff-hono && pnpm vitest run`
Expected: PASS，含 4 个新测试。

- [ ] **Step 7: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功。

- [ ] **Step 8: 提交**

```bash
git add packages/bff-hono/src/index.ts packages/bff-hono/src/*.test.ts
git commit -m "feat(bff-hono): /run 透传 stepMode，新增 /continue 端点

/continue 不要求 callId，把 sessionId 加 subject 前缀后调 harness.continue。
input 可选，作为中途注入消息。"
```

---

### Task 4: flutter-dev-bff Web UI 循环驱动

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`（HTML 输入栏 + `<script>` 中的变量与 `sendMessage`）

**Interfaces:**
- Consumes: Task 3 的 `POST /continue`。
- Produces: UI 在 stepMode 下循环：`/run` → 收到 `step_done` 就 `/continue`，直到 `final`；停止按钮中断循环；步数计数。

这是终端消费者改动，无自动化测试（纯浏览器行为），用 `pnpm -r test` 确保后端不回归，人工验证交互。

- [ ] **Step 1: 加停止按钮与 hidden 样式**

在 `public/index.html` 的 `<style>` 段中加入：

```css
  .hidden { display: none !important; }
```

把输入栏（约 58-60 行）：

```html
  <textarea id="input" rows="1" placeholder="输入指令，例如：启动应用并检查首页是否正常显示..." autofocus></textarea>
  <button id="send">发送</button>
```

改为：

```html
  <textarea id="input" rows="1" placeholder="输入指令，例如：启动应用并检查首页是否正常显示..." autofocus></textarea>
  <button id="send">发送</button>
  <button id="stop" class="hidden">停止</button>
```

- [ ] **Step 2: 加 stopBtn 与停止标志**

在脚本中找到 `const sendBtn = document.getElementById('send');`（约 71 行），在其后加：

```js
const stopBtn = document.getElementById('stop');
let stopRequested = false;
stopBtn.addEventListener('click', () => { stopRequested = true; });
```

- [ ] **Step 3: 给 /run 请求加 stepMode**

在 `sendMessage` 内，找到请求体 `const body = { ... }`，加入 `stepMode: true`：

```js
    const body = {
      input: text,
      context: { timestamp: new Date().toISOString(), platform: 'android' },
      stepMode: true,
      ...(promptEl.value !== 'free-form' ? { promptName: promptEl.value } : {}),
    };
```

- [ ] **Step 4: 改造结果循环处理 step_done**

把现有的结果处理段：

```js
    while (result.type === 'pending_tool_calls') {
      // Server tools execute in-process, so pending_tool_calls shouldn't occur in MVP.
      // But handle it gracefully.
      typingEl.innerHTML = '等待工具执行...';
      break;
    }

    if (result.type === 'final') {
```

替换为（保留 `pending_tool_calls` 分支作为防御，并新增 `step_done` 循环）：

```js
    let stepCount = 0;
    while (result.type === 'pending_tool_calls') {
      // flutter-dev-bff 全是 server 工具，正常不会走到这里；保留防御。
      typingEl.innerHTML = '等待工具执行...';
      break;
    }
    while (result.type === 'step_done') {
      if (stopRequested) {
        typingEl.innerHTML = '已停止';
        break;
      }
      stepCount += 1;
      statusEl.textContent = `思考中…（第 ${stepCount} 步）`;
      result = await fetch(`${BASE}/v1/agent/sessions/${sessionId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
        body: JSON.stringify({ context: { timestamp: new Date().toISOString(), platform: 'android' } }),
      }).then((r) => r.json());
    }

    if (result.type === 'final') {
```

- [ ] **Step 5: 在 finally 中控制停止按钮显隐**

在 `sendMessage` 开头（`running = true;` 附近）加：

```js
  stopRequested = false;
  stopBtn.classList.remove('hidden');
```

在 `finally` 块中加：

```js
    stopBtn.classList.add('hidden');
```

- [ ] **Step 6: 验证后端未回归**

Run: `pnpm -r test`
Expected: 全部通过（UI 改动不影响测试）。

- [ ] **Step 7: 人工验证**

启动服务（需要填好 `.env`），打开 `http://localhost:8788`，发送「列出连接的设备」：

- 状态从「思考中…（第 N 步）」变化
- 任务正常返回最终答案
- 点「停止」能中断循环
- DevTools Network 里能看到 `/run` 后跟若干 `/continue`

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/public/index.html
git commit -m "feat(flutter-dev-bff): Web UI 改为 stepMode 循环驱动

/run 带 stepMode:true，收到 step_done 就 /continue 直到 final。
加停止按钮（取消=不再请求下一步）与步数显示。SSE 仍负责步内
可见性（长工具运行期间），两者互补。"
```

---

## 收尾说明

完成后，`mobile_set_text` 的中文路径、SSE 事件流、分步循环三者协同：

- 长工具（如 `flutter_test`）运行期间，SSE 推送 `tool_start`/`tool_end`，UI 不冻结
- 每轮工具结束后 harness 返回 `step_done`，UI 可选择继续、停止或注入消息
- 停止不需要服务端中断在途循环——正在跑的那一步会跑完，但不会有下一步

本计划**不包含**把 flutter-dev-bff 的 `maxSteps` 从 50 调到 500（那是中文输入 spec 之外的独立决定，可在真机验证时按需要改 `server.ts`）。

浏览器插件（`BOOS_browser_ext`）路径完全不变：它不传 `stepMode`，`run()` 行为逐字节不变，仍由插件自己持有循环。
