# Flutter Dev BFF SSE 步内可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 向 Web UI 实时推送工具执行事件，使 `flutter_test` 这类长达 300 秒的工具运行期间能看清 Agent 卡在哪一步。

**Architecture:** BFF 层新增纯内存 EventBus（含环形缓冲支持 `Last-Event-ID` 续传）。用 map 包装 `ToolDefinition.execute` 在执行前后发事件，不修改 core。SSE 端点用 Hono 自带的 `streamSSE` 实现，广播给所有连接，不按会话隔离。

**Tech Stack:** TypeScript (ESM)、Hono 4.8.5（`hono/streaming` 的 `streamSSE`）、`@hono/node-server` 2.1.0、vitest 3.2.4

## Global Constraints

- 只修改 `examples/flutter-dev-bff`。不得改动 `packages/` 下任何基础模块，不得改动 `examples/browser-extension-bff`。
- 不修改 core 的 `ToolExecutionContext` 契约。工具埋点全部在 BFF 层用 map 包装 `execute` 完成。
- 截断上限 2KB。`mobile_snapshot` 返回整棵无障碍树，不截断单条事件可达数十 KB。
- 环形缓冲 200 条。
- 心跳间隔 15 秒，用 `: ` 注释行。
- SSE 鉴权走 `?token=` 查询参数（浏览器 `EventSource` 不支持自定义请求头）。
- 事件默认档只有 `tool_start` / `tool_end`。**不设 `run_start` / `run_end`**。
- verbose 档的 LLM 事件**只推摘要字段**，绝不推 `body` 与 `responseBody`（它们含 system prompt 全文与模型原文）。
- 起点：148 个测试通过。每个任务结束时 `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。

---

## File Structure

- `examples/flutter-dev-bff/src/services/event-bus.ts` — 新建。纯内存事件总线，seq 分配、环形缓冲、订阅/退订。不依赖 Hono 或 core。
- `examples/flutter-dev-bff/src/services/event-bus.test.ts` — 新建。
- `examples/flutter-dev-bff/src/tool-events.ts` — 新建。`truncate` 与 `instrumentTools`。放在 `src/` 而非 `services/`，因为它依赖 core 的 `ToolDefinition` 类型，与 `flutter-tools.ts` 同层。
- `examples/flutter-dev-bff/src/tool-events.test.ts` — 新建。
- `examples/flutter-dev-bff/src/server.ts` — 修改。创建 bus、包装工具、新增 `/api/events` 端点、返回 bus 供测试、verbose 档接 LLM 事件。
- `examples/flutter-dev-bff/src/sse.test.ts` — 新建。SSE 端点的真实 HTTP 测试。与 `bridge.test.ts` 分开，因为它需要读取流式响应体，断言方式不同。
- `examples/flutter-dev-bff/public/index.html` — 修改。接 `EventSource`，实时渲染工具事件。

---

### Task 1: EventBus

**Files:**
- Create: `examples/flutter-dev-bff/src/services/event-bus.ts`
- Test: `examples/flutter-dev-bff/src/services/event-bus.test.ts`

**Interfaces:**
- Consumes: 无。这是叶子模块。
- Produces: `createEventBus(options?: { bufferSize?: number }): EventBus`；类型 `FlutterEvent`（含 `seq: number`、`ts: number`、`type: string`，其余字段任意）与 `EventBus`（`emit(event)` 接收不含 seq/ts 的对象；`subscribe(listener, fromSeq?)` 返回退订函数）。Task 2 与 Task 3 都依赖这两个类型名。

- [ ] **Step 1: 写失败的测试**

创建 `src/services/event-bus.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import type { FlutterEvent } from './event-bus.js'

describe('EventBus', () => {
  it('seq 从 1 开始单调递增，并自动补 ts', () => {
    const bus = createEventBus()
    const received: FlutterEvent[] = []
    bus.subscribe((event) => received.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })
    bus.emit({ type: 'tool_end', name: 'a' })

    expect(received.map((e) => e.seq)).toEqual([1, 2])
    expect(received[0].type).toBe('tool_start')
    expect(typeof received[0].ts).toBe('number')
  })

  it('退订后不再收到事件', () => {
    const bus = createEventBus()
    const received: FlutterEvent[] = []
    const unsubscribe = bus.subscribe((event) => received.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })
    unsubscribe()
    bus.emit({ type: 'tool_start', name: 'b' })

    expect(received).toHaveLength(1)
  })

  it('多个订阅者都收到同一事件', () => {
    const bus = createEventBus()
    const first: FlutterEvent[] = []
    const second: FlutterEvent[] = []
    bus.subscribe((event) => first.push(event))
    bus.subscribe((event) => second.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it('环形缓冲不超过上限', () => {
    const bus = createEventBus({ bufferSize: 3 })
    for (let i = 0; i < 10; i += 1) bus.emit({ type: 'tool_start', index: i })

    const replayed: FlutterEvent[] = []
    bus.subscribe((event) => replayed.push(event), 0)

    expect(replayed).toHaveLength(3)
    expect(replayed.map((e) => e.seq)).toEqual([8, 9, 10])
  })

  it('subscribe 传 fromSeq 时只重放更新的事件', () => {
    const bus = createEventBus()
    bus.emit({ type: 'tool_start', name: 'a' })
    bus.emit({ type: 'tool_start', name: 'b' })
    bus.emit({ type: 'tool_start', name: 'c' })

    const replayed: FlutterEvent[] = []
    bus.subscribe((event) => replayed.push(event), 2)

    expect(replayed.map((e) => e.seq)).toEqual([3])
  })

  it('不传 fromSeq 时不重放历史，只收后续事件', () => {
    const bus = createEventBus()
    bus.emit({ type: 'tool_start', name: 'old' })

    const received: FlutterEvent[] = []
    bus.subscribe((event) => received.push(event))
    bus.emit({ type: 'tool_start', name: 'new' })

    expect(received).toHaveLength(1)
    expect(received[0].name).toBe('new')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/event-bus.test.ts`

Expected: FAIL，报找不到模块 `./event-bus.js`。

- [ ] **Step 3: 实现 EventBus**

创建 `src/services/event-bus.ts`：

```ts
export interface FlutterEvent {
  seq: number
  ts: number
  type: string
  [key: string]: unknown
}

export interface EventBus {
  emit(event: { type: string; [key: string]: unknown }): void
  /** fromSeq 有值时先重放缓冲中 seq 大于它的事件，再接收后续事件。 */
  subscribe(listener: (event: FlutterEvent) => void, fromSeq?: number): () => void
}

export function createEventBus(options: { bufferSize?: number } = {}): EventBus {
  const bufferSize = options.bufferSize ?? 200
  const buffer: FlutterEvent[] = []
  const listeners = new Set<(event: FlutterEvent) => void>()
  let seq = 0

  return {
    emit(event) {
      seq += 1
      const full: FlutterEvent = { ...event, seq, ts: Date.now() }
      buffer.push(full)
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
      for (const listener of listeners) listener(full)
    },
    subscribe(listener, fromSeq) {
      if (fromSeq !== undefined) {
        for (const event of buffer) {
          if (event.seq > fromSeq) listener(event)
        }
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/event-bus.test.ts`

Expected: PASS，6 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/services/event-bus.ts examples/flutter-dev-bff/src/services/event-bus.test.ts
git commit -m "feat: 新增内存 EventBus，支持环形缓冲与按 seq 重放

环形缓冲的必要性在于 EventSource 重连时携带 Last-Event-ID，
需靠缓冲补齐断开期间的事件，否则重连等于丢事件。"
```

---

### Task 2: 工具埋点包装与截断

**Files:**
- Create: `examples/flutter-dev-bff/src/tool-events.ts`
- Test: `examples/flutter-dev-bff/src/tool-events.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `EventBus` 类型（`emit(event)` / `subscribe(listener, fromSeq?)`），从 `./services/event-bus.js` 导入。
- Produces: `truncate(value: unknown, limit?: number): string`；`instrumentTools(definitions: ToolDefinition[], bus: EventBus): ToolDefinition[]`。Task 3 调用 `instrumentTools`。

- [ ] **Step 1: 写失败的测试**

创建 `src/tool-events.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolDefinition } from '@agent-kit/core'
import { createEventBus } from './services/event-bus.js'
import type { FlutterEvent } from './services/event-bus.js'
import { instrumentTools, truncate } from './tool-events.js'

function collect(bus: ReturnType<typeof createEventBus>): FlutterEvent[] {
  const events: FlutterEvent[] = []
  bus.subscribe((event) => events.push(event))
  return events
}

const okTool: ToolDefinition = {
  name: 'demo_ok',
  execution: 'server',
  input: z.object({ q: z.string() }),
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
}

describe('truncate', () => {
  it('短内容原样序列化', () => {
    expect(truncate({ a: 1 })).toBe('{"a":1}')
  })

  it('超长内容被截断并标记', () => {
    const long = { text: 'x'.repeat(5000) }
    const result = truncate(long, 100)

    expect(result.length).toBeLessThan(200)
    expect(result).toContain('truncated')
  })

  it('无法序列化的值不抛异常', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => truncate(circular)).not.toThrow()
  })
})

describe('instrumentTools', () => {
  it('执行成功时发出 tool_start 与 tool_end', async () => {
    const bus = createEventBus()
    const events = collect(bus)
    const [wrapped] = instrumentTools([okTool], bus)

    await wrapped.execute!({ q: 'hi' }, { signal: new AbortController().signal })

    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[0].name).toBe('demo_ok')
    expect(events[1].ok).toBe(true)
    expect(typeof events[1].durationMs).toBe('number')
  })

  it('透传原始返回值', async () => {
    const bus = createEventBus()
    const [wrapped] = instrumentTools([okTool], bus)

    const result = await wrapped.execute!({ q: 'hi' }, { signal: new AbortController().signal })

    expect(result).toEqual({ ok: true })
  })

  it('抛错时发出 ok:false 事件并原样抛出同一个异常', async () => {
    const boom = new Error('设备未连接')
    const failing: ToolDefinition = {
      name: 'demo_fail',
      execution: 'server',
      input: z.object({}),
      output: z.object({}),
      execute: async () => { throw boom },
    }
    const bus = createEventBus()
    const events = collect(bus)
    const [wrapped] = instrumentTools([failing], bus)

    await expect(
      wrapped.execute!({}, { signal: new AbortController().signal }),
    ).rejects.toBe(boom)

    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[1].ok).toBe(false)
    expect(String(events[1].error)).toContain('设备未连接')
  })

  it('没有 execute 的工具原样透传，不包装', () => {
    const remote: ToolDefinition = {
      name: 'demo_remote',
      execution: 'remote',
      input: z.object({}),
      output: z.object({}),
    }
    const [wrapped] = instrumentTools([remote], createEventBus())

    expect(wrapped).toBe(remote)
  })

  it('保留 name、execution、schema 与 timeoutMs', () => {
    const timed: ToolDefinition = { ...okTool, timeoutMs: 12_345 }
    const [wrapped] = instrumentTools([timed], createEventBus())

    expect(wrapped.name).toBe('demo_ok')
    expect(wrapped.execution).toBe('server')
    expect(wrapped.timeoutMs).toBe(12_345)
    expect(wrapped.input).toBe(timed.input)
    expect(wrapped.output).toBe(timed.output)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/tool-events.test.ts`

Expected: FAIL，报找不到模块 `./tool-events.js`。

- [ ] **Step 3: 实现**

创建 `src/tool-events.ts`：

```ts
import type { ToolDefinition } from '@agent-kit/core'
import type { EventBus } from './services/event-bus.js'

/** 序列化并截断，用于事件载荷。mobile_snapshot 返回整棵无障碍树，不截断会拖垮浏览器。 */
export function truncate(value: unknown, limit = 2000): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[truncated, ${text.length} chars]`
}

export function instrumentTools(definitions: ToolDefinition[], bus: EventBus): ToolDefinition[] {
  return definitions.map((definition) => {
    const original = definition.execute
    if (!original) return definition
    return {
      ...definition,
      execute: async (input, context) => {
        bus.emit({ type: 'tool_start', name: definition.name, input: truncate(input) })
        const startedAt = Date.now()
        try {
          const output = await original(input, context)
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: true,
            durationMs: Date.now() - startedAt,
            output: truncate(output),
          })
          return output
        } catch (error) {
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
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

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/tool-events.test.ts`

Expected: PASS，9 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/tool-events.ts examples/flutter-dev-bff/src/tool-events.test.ts
git commit -m "feat: 新增工具埋点包装，在 execute 前后发出事件

在 BFF 层 map 包装 ToolDefinition.execute，不修改 core 契约。
异常必须原样抛出：harness 依赖捕获原始错误并转成 ok:false 结果
回传给模型。载荷截断至 2KB，mobile_snapshot 的无障碍树否则可达数十 KB。"
```

---

### Task 3: 接入 server.ts 并新增 SSE 端点

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`（import 段、`createFlutterDevBff` 内部、返回值）
- Test: `examples/flutter-dev-bff/src/sse.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `createEventBus`；Task 2 的 `instrumentTools`。
- Produces: `createFlutterDevBff` 的返回对象新增 `bus: EventBus` 字段（测试需要主动 emit 事件验证推送）。新增路由 `GET /api/events?token=...`。

SSE 循环采用轮询队列（250ms）而非事件驱动唤醒：实现简单得多，而 250ms 延迟对盯着 5 分钟工具的人不可感知。心跳按 15 秒独立计时，不受轮询间隔影响。

- [ ] **Step 1: 写失败的测试**

创建 `src/sse.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createFlutterDevBff, startFlutterDevBffServer } from './server.js'

const masterKey = 'A'.repeat(43)
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function start() {
  const bff = createFlutterDevBff({
    masterKey,
    apiToken: 'token-1',
    flutterProjectPath: '/tmp/flutter-app',
    databasePath: ':memory:',
  })
  await bff.ready
  const { server, port } = await startFlutterDevBffServer((request) => bff.app.fetch(request), 0)
  cleanups.push(() => {
    server.close()
    bff.database.close()
  })
  return { bff, port }
}

/** 从 SSE 流中读取，直到累积文本包含 marker 或超时。 */
async function readUntil(body: ReadableStream<Uint8Array>, marker: string, timeoutMs = 5000): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(marker)) return text
    }
  } finally {
    await reader.cancel()
  }
  return text
}

describe('SSE 端点', () => {
  it('无 token 返回 401', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events`)

    expect(res.status).toBe(401)
  })

  it('错误 token 返回 401', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=wrong`)

    expect(res.status).toBe(401)
  })

  it('鉴权通过返回 text/event-stream', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body!.cancel()
  })

  it('bus 上 emit 的事件会推送到已连接客户端', async () => {
    const { bff, port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    // 连接建立后再 emit，验证的是实时推送而非重放
    await new Promise((resolve) => setTimeout(resolve, 300))
    bff.bus.emit({ type: 'tool_start', name: 'mobile_snapshot' })

    const text = await readUntil(res.body!, 'mobile_snapshot')

    expect(text).toContain('event: tool_start')
    expect(text).toContain('mobile_snapshot')
  })

  it('Last-Event-ID 重放断开期间的事件', async () => {
    const { bff, port } = await start()
    bff.bus.emit({ type: 'tool_start', name: 'first' })
    bff.bus.emit({ type: 'tool_start', name: 'second' })

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`, {
      headers: { 'last-event-id': '1' },
    })

    const text = await readUntil(res.body!, 'second')

    expect(text).toContain('second')
    expect(text).not.toContain('first')
  })

  it('工具执行会自动产生事件，无需手动 emit', async () => {
    const { bff, port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const tool = bff.runtime.tools.get('mobile_devices')
    await tool!.execute!({}, { signal: new AbortController().signal }).catch(() => {})

    const text = await readUntil(res.body!, 'mobile_devices')

    expect(text).toContain('mobile_devices')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/sse.test.ts`

Expected: FAIL。前三个测试因 `/api/events` 路由不存在得到 404 而非 401/200；后三个因 `bff.bus` 是 undefined 而报错。

- [ ] **Step 3: 加入 import 与 bus 创建、包装工具**

在 `src/server.ts` 的 import 段加入（`streamSSE` 来自 Hono 自带 helper，无需新依赖）：

```ts
import { streamSSE } from 'hono/streaming'
import { createEventBus } from './services/event-bus.js'
import { instrumentTools } from './tool-events.js'
```

在 `createFlutterDevBff` 内部创建 bus，并把工具注册改为注册包装后的版本。

**bus 必须创建在 runtime 之前**——Task 4 会在 runtime 的 `llmTrace` 里引用它。在 `const prompts = createPromptRegistry()` 那一行之前插入：

```ts
  const bus = createEventBus()
```

然后找到工具注册这一行（当前 [server.ts:103](../../../examples/flutter-dev-bff/src/server.ts:103)）：

```ts
  for (const tool of toolDefinitions) runtime.tools.register(tool)
```

替换为：

```ts
  for (const tool of instrumentTools(toolDefinitions, bus)) runtime.tools.register(tool)
```

- [ ] **Step 4: 新增 SSE 端点**

在 `src/server.ts` 的 `/api/screenshots/:id` 路由之后、`const ready = seedSecret(...)` 之前插入：

```ts
  app.get('/api/events', (c) => {
    // 浏览器 EventSource 不支持自定义请求头，因此 token 走查询参数。
    // 服务只绑 loopback，接受 token 落入日志的代价以换取 EventSource 自带的重连。
    if (c.req.query('token') !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const lastEventId = c.req.header('last-event-id')
    const fromSeq = lastEventId !== undefined ? Number(lastEventId) : undefined

    return streamSSE(c, async (stream) => {
      const queue: FlutterEvent[] = []
      const unsubscribe = bus.subscribe((event) => queue.push(event), fromSeq)
      stream.onAbort(unsubscribe)
      let lastPing = Date.now()
      try {
        while (!stream.aborted && !stream.closed) {
          while (queue.length > 0) {
            const event = queue.shift() as FlutterEvent
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: event.type,
              id: String(event.seq),
            })
          }
          if (Date.now() - lastPing >= 15_000) {
            // 注释行心跳：保持连接，并让写失败暴露出已死的客户端。
            await stream.write(': ping\n\n')
            lastPing = Date.now()
          }
          await stream.sleep(250)
        }
      } finally {
        unsubscribe()
      }
    })
  })
```

同时在 import 段补上类型：

```ts
import type { FlutterEvent } from './services/event-bus.js'
```

- [ ] **Step 5: 把 bus 加入返回值**

找到 `createFlutterDevBff` 的 return 语句（当前 [server.ts:144](../../../examples/flutter-dev-bff/src/server.ts:144)）：

```ts
  return { app, runtime, database, prompts, adb, flutter, ready }
```

替换为：

```ts
  return { app, runtime, database, prompts, adb, flutter, bus, ready }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/sse.test.ts`

Expected: PASS，6 个测试全过。

- [ ] **Step 7: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`

Expected: 三条命令均成功。测试 169 通过（148 + Task 1 的 6 + Task 2 的 9 + 本任务 6）。`examples/browser-extension-bff` 的 26 个测试通过，是未影响插件路径的证据（见 [AGENTS.md](../../../AGENTS.md)）。

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/sse.test.ts
git commit -m "feat: 新增 /api/events SSE 端点，推送工具执行事件

用 Hono 自带 streamSSE 实现，广播不按会话隔离——服务已绑 loopback，
广播范围即单机单人。轮询队列 250ms 而非事件驱动唤醒：实现简单得多，
该延迟对盯着 5 分钟工具的人不可感知。心跳 15 秒独立计时。"
```

---

### Task 4: verbose 档推送 LLM 摘要事件

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`（`createFlutterDevBff` 内部 runtime 创建处）
- Test: `examples/flutter-dev-bff/src/tool-events.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `EventBus`；core 的 `LlmTraceEvent` 类型（已在 server.ts import）。
- Produces: `llmTraceToBus(bus: EventBus): (event: LlmTraceEvent) => void`，导出自 `src/tool-events.ts`。

安全约束：`LlmTraceEvent.body` 是完整 HTTP 请求体（含 system prompt 全文与全部会话消息），`responseBody` 是模型原文。这与 `AuditLogger` 契约明确禁止记录的内容重叠，因此**只提取摘要字段**。

- [ ] **Step 1: 写失败的测试**

在 `src/tool-events.test.ts` 末尾追加：

```ts
describe('llmTraceToBus', () => {
  it('request 阶段只推摘要，不含 prompt 正文与消息内容', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({
      requestId: 'req-1',
      phase: 'request',
      durationMs: 0,
      body: {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '这是绝密系统提示词' },
          { role: 'user', content: '这是用户消息' },
        ],
        tools: [{ name: 't1' }, { name: 't2' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('llm_request')
    expect(events[0].model).toBe('deepseek-chat')
    expect(events[0].messageCount).toBe(2)
    expect(events[0].toolCount).toBe(2)

    const dump = JSON.stringify(events[0])
    expect(dump).not.toContain('绝密系统提示词')
    expect(dump).not.toContain('这是用户消息')
  })

  it('response 阶段只推摘要，不含模型原文', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({
      requestId: 'req-2',
      phase: 'response',
      durationMs: 1234,
      responseBody: {
        choices: [{ message: { content: '模型的完整回复正文' }, finish_reason: 'stop' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('llm_response')
    expect(events[0].durationMs).toBe(1234)
    expect(events[0].finishReason).toBe('stop')
    expect(JSON.stringify(events[0])).not.toContain('模型的完整回复正文')
  })

  it('error 阶段推错误事件', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({ requestId: 'req-3', phase: 'error', durationMs: 50, error: new Error('连接超时') })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('llm_error')
    expect(String(events[0].error)).toContain('连接超时')
  })
})
```

并在该文件顶部的 import 中补上 `llmTraceToBus`：

```ts
import { instrumentTools, llmTraceToBus, truncate } from './tool-events.js'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/tool-events.test.ts`

Expected: FAIL，`llmTraceToBus` 未导出。

- [ ] **Step 3: 实现**

在 `src/tool-events.ts` 顶部补上类型 import：

```ts
import type { LlmTraceEvent, ToolDefinition } from '@agent-kit/core'
```

在文件末尾追加：

```ts
/**
 * 把 LlmTraceEvent 转成只含摘要的事件推给 bus。
 *
 * 绝不推 body 与 responseBody：前者含 system prompt 全文与全部会话消息，
 * 后者是模型原文，二者都属于 AuditLogger 契约明确禁止记录的内容。
 */
export function llmTraceToBus(bus: EventBus): (event: LlmTraceEvent) => void {
  return (event) => {
    if (event.phase === 'request') {
      const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
      bus.emit({
        type: 'llm_request',
        requestId: event.requestId,
        model: typeof body.model === 'string' ? body.model : 'unknown',
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      })
      return
    }
    if (event.phase === 'response') {
      const choices = (event.responseBody as { choices?: unknown } | undefined)?.choices
      const first = Array.isArray(choices)
        ? (choices[0] as { finish_reason?: unknown; message?: { tool_calls?: unknown } } | undefined)
        : undefined
      bus.emit({
        type: 'llm_response',
        requestId: event.requestId,
        durationMs: event.durationMs,
        finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'unknown',
        toolCallCount: Array.isArray(first?.message?.tool_calls) ? first.message.tool_calls.length : 0,
      })
      return
    }
    bus.emit({
      type: 'llm_error',
      requestId: event.requestId,
      durationMs: event.durationMs,
      error: event.error instanceof Error ? event.error.message : String(event.error),
    })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/tool-events.test.ts`

Expected: PASS，12 个测试全过。

- [ ] **Step 5: 在 verbose 档接上 bus**

在 `src/server.ts` 的 `createFlutterDevBff` 中，找到 runtime 创建处传入 `llmTrace` 的那一行（当前 [server.ts:101](../../../examples/flutter-dev-bff/src/server.ts:101)）：

```ts
    ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
```

替换为（外部传入的 trace 与推 bus 的组合，两者都执行）：

```ts
    ...(options.llmTrace
      ? {
          llmTrace: (event: LlmTraceEvent) => {
            options.llmTrace?.(event)
            llmTraceToBus(bus)(event)
          },
        }
      : {}),
```

并把 import 改为包含 `llmTraceToBus`：

```ts
import { instrumentTools, llmTraceToBus } from './tool-events.js'
```

`bus` 已在 Task 3 中创建于 runtime 之前，此处直接引用即可。

- [ ] **Step 6: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`

Expected: 三条命令均成功。测试 172 通过（169 + 本任务 3）。

- [ ] **Step 7: 提交**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/tool-events.ts examples/flutter-dev-bff/src/tool-events.test.ts
git commit -m "feat: verbose 档向 SSE 推送 LLM 摘要事件

只提取 model、messageCount、toolCount、finishReason 等摘要字段。
绝不推 body 与 responseBody——前者含 system prompt 全文与全部会话
消息，后者是模型原文，均属 AuditLogger 契约禁止记录的内容。测试
显式断言事件序列化后不含 prompt 正文。"
```

---

### Task 5: Web UI 接入 EventSource

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`（`<script>` 段）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/events?token=...`。事件类型 `tool_start` / `tool_end`，`data` 为 JSON 字符串，字段见 Task 1、Task 2。
- Produces: 无。终端消费者。

此任务无自动化测试——纯浏览器行为，需人工验证。现有的 `addToolMessage(toolName, status, output)` 函数（[index.html:104](../../../examples/flutter-dev-bff/public/index.html:104)）可直接复用。

- [ ] **Step 1: 建立 EventSource 连接并渲染事件**

在 `public/index.html` 的 `<script>` 段中，找到 `let running = false;` 这一行，在其后插入：

```js
// 工具事件实时流。EventSource 不支持自定义请求头，token 走查询参数。
// 断线自动重连，重连时浏览器自动带上 Last-Event-ID，服务端据此重放断开期间的事件。
const toolEls = new Map();

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);

  es.addEventListener('tool_start', (e) => {
    const data = JSON.parse(e.data);
    const el = addToolMessage(data.name, '执行中…');
    toolEls.set(data.name, el);
  });

  es.addEventListener('tool_end', (e) => {
    const data = JSON.parse(e.data);
    const el = toolEls.get(data.name);
    const status = data.ok ? `完成 ${data.durationMs}ms` : `失败 ${data.durationMs}ms`;
    const detail = data.ok ? data.output : data.error;
    if (el) {
      el.className = 'msg tool' + (data.ok ? '' : ' error');
      el.innerHTML = `<div><span class="tool-name">${escapeHtml(data.name)}</span> <span class="tool-status">${escapeHtml(status)}</span></div>`
        + (detail ? `<div class="tool-output">${escapeHtml(String(detail).slice(0, 500))}</div>` : '');
      toolEls.delete(data.name);
    } else {
      addToolMessage(data.name, status, detail);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  es.onerror = () => {
    // EventSource 会自行重连，这里只反映连接状态，不手动重建。
    statusEl.textContent = running ? '思考中…（事件流重连中）' : '事件流重连中…';
  };

  es.onopen = () => {
    if (!running) statusEl.textContent = '就绪';
  };

  return es;
}

connectEvents();
```

- [ ] **Step 2: 构建并启动服务人工验证**

Run: `cd examples/flutter-dev-bff && pnpm build`

需要一个填好的 `.env`（`AGENT_KIT_MASTER_KEY`、`BFF_API_TOKEN`、`FLUTTER_PROJECT_PATH`、`LLM_API_KEY`、`LLM_MODEL`）。启动：

Run: `cd examples/flutter-dev-bff && pnpm start`

打开 `http://localhost:8788`，输入「列出连接的设备」。

Expected：`mobile_devices` 的卡片先显示「执行中…」，随后原地变为「完成 NNNms」并展示输出。若 `.env` 或设备不可用，至少应看到工具卡片出现并变为「失败」状态——这同样验证了事件流打通。

在浏览器 DevTools 的 Network 面板中，`/api/events` 请求应为 pending 状态（长连接），EventStream 标签下能看到逐条事件。

- [ ] **Step 3: 验证断线重连**

服务运行中，在终端按 Ctrl+C 停止，观察页面状态变为「事件流重连中…」。重新 `pnpm start`，状态应自动恢复为「就绪」，无需刷新页面。

- [ ] **Step 4: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`

Expected: 三条命令均成功，测试仍为 172 通过（本任务不新增测试）。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/public/index.html
git commit -m "feat: Web UI 接入 EventSource 实时显示工具执行状态

工具卡片先显示执行中，事件返回后原地更新为完成/失败与耗时，
替换原先整个运行期只有静态「思考中…」的行为。EventSource 自带
重连，重连时浏览器自动带 Last-Event-ID 补齐断开期间的事件。"
```

---

## 收尾说明

`FLUTTER_DEV_BFF.md` 中以下内容在本计划完成后应更新，但不在本计划范围内：

- Phase 3 收尾清单里的 EventBus + SSE 项可标记完成。
- `.env.example` 待办项无必要（`ensureEnvTemplate()` 已自动生成 `.env`）。
- `mobile_snapshot`「工具列表第一个」的描述有误（实际位于数组第 6 位）。

本计划不实现取消/中断与步数限制，那部分见 [取消/中断与步数限制设计](../specs/2026-08-12-cancel-and-step-limit-design.md)。两者独立，事件结构不受其影响。
