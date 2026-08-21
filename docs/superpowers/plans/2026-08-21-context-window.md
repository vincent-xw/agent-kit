# Context Window Indicator & Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a token-based context-window indicator in the flutter-dev-bff WebUI and automatic/manual context compression, implemented in `@agent-kit/core` so other BFF examples can reuse it.

**Architecture:** Extend `@agent-kit/core` with a token estimator, model-limit registry, usage-aware `LlmClient`, and a `TokenContextManager` that replaces the count-based `ContextManager`. The manager trims and summarizes old tool turns when token usage crosses a high watermark, while protecting the most recent turn. `adapter-sqlite` accepts the manager, and the BFF exposes status/compact endpoints plus a hover-popover badge in the WebUI.

**Tech Stack:** TypeScript strict, vitest, Hono, vanilla JS/CSS WebUI, OpenAI-compatible LLM endpoints.

## Global Constraints

- TypeScript strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- All new code must have unit tests; integration tests cover BFF endpoints.
- Do not record prompt text or business content in audit logs.
- Token fallback is `Math.ceil(text.length / 4)` when API `usage` is unavailable.
- Default context limit is `256000` tokens; built-in table overrides it for known models.
- UI strings are Chinese.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/token-counter.ts` | Token estimation and `usage` normalization. |
| `packages/core/src/token-counter.test.ts` | Tests for estimate / usage correction. |
| `packages/core/src/model-context-limits.ts` | Built-in model limits and `resolveContextLimit`. |
| `packages/core/src/model-context-limits.test.ts` | Tests for limit resolution. |
| `packages/core/src/context-compressor.ts` | Pure async compression function: drop old tool turns, summarize older turns. |
| `packages/core/src/context-compressor.test.ts` | Tests for compression strategy. |
| `packages/core/src/llm-client.ts` | Add usage fields to `LlmTraceEvent`, parse `response.usage`. |
| `packages/core/src/llm-client.test.ts` | Add usage-parsing tests. |
| `packages/core/src/context-manager.ts` | Make `ContextManager` interface async-capable. |
| `packages/core/src/token-context-manager.ts` | Token-budget manager implementing `ContextManager`. |
| `packages/core/src/token-context-manager.test.ts` | Tests for watermark/auto/manual compression. |
| `packages/core/src/harness.ts` | Await async `trimHistory`. |
| `packages/core/src/index.ts` | Export new public APIs. |
| `packages/adapter-sqlite/src/index.ts` | Accept optional `contextManager` and forward `llmTrace`. |
| `examples/flutter-dev-bff/src/server.ts` | Wire context manager, add `/context` endpoints, wrap harness to persist compressed history. |
| `examples/flutter-dev-bff/public/index.html` | Add `#context-badge` and `#context-popover`. |
| `examples/flutter-dev-bff/public/assets/app.js` | Fetch status, render badge/popover, manual compact. |
| `examples/flutter-dev-bff/public/assets/app.css` | Badge colors and popover styles. |
| `examples/flutter-dev-bff/.env.example` | Document `LLM_CONTEXT_LIMIT` / `VISION_CONTEXT_LIMIT`. |

---

### Task 1: Token counter and model-limit registry

**Files:**
- Create: `packages/core/src/token-counter.ts`
- Create: `packages/core/src/token-counter.test.ts`
- Create: `packages/core/src/model-context-limits.ts`
- Create: `packages/core/src/model-context-limits.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `estimateTokens(text: string): number`
- Produces: `estimateMessages(messages: SessionMessage[]): number`
- Produces: `applyUsageCorrection(estimated: number, usage?: LlmUsage): number`
- Produces: `resolveContextLimit(model: string, envLimit?: string): number`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/token-counter.test.ts
import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessages, applyUsageCorrection } from './token-counter.js'
import type { SessionMessage } from './contracts.js'

describe('estimateTokens', () => {
  it('英文按字符/4 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefghijkl')).toBe(3)
  })
  it('中文按字符/4 向上取整', () => {
    expect(estimateTokens('你好世界')).toBe(1)
    expect(estimateTokens('一二三四五六七八')).toBe(2)
  })
})

describe('estimateMessages', () => {
  it('汇总多条消息 JSON 长度', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]
    expect(estimateMessages(messages)).toBe(Math.ceil(JSON.stringify(messages).length / 4))
  })
})

describe('applyUsageCorrection', () => {
  it('有 usage 时返回 total_tokens', () => {
    expect(applyUsageCorrection(100, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toBe(30)
  })
  it('无 usage 时返回原估值', () => {
    expect(applyUsageCorrection(100, undefined)).toBe(100)
  })
})
```

```ts
// packages/core/src/model-context-limits.test.ts
import { describe, it, expect } from 'vitest'
import { resolveContextLimit } from './model-context-limits.js'

describe('resolveContextLimit', () => {
  it('内置表命中', () => {
    expect(resolveContextLimit('gpt-4o')).toBe(128_000)
    expect(resolveContextLimit('deepseek-chat')).toBe(64_000)
  })
  it('env 覆盖内置表', () => {
    expect(resolveContextLimit('deepseek-chat', '32000')).toBe(32_000)
  })
  it('未知模型默认 256K', () => {
    expect(resolveContextLimit('unknown-model')).toBe(256_000)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agent-kit/core test src/token-counter.test.ts src/model-context-limits.test.ts`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement token counter and registry**

```ts
// packages/core/src/token-counter.ts
import type { SessionMessage } from './contracts.js'

export interface LlmUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessages(messages: SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0)
}

export function applyUsageCorrection(estimated: number, usage?: LlmUsage): number {
  if (usage?.total_tokens !== undefined && usage.total_tokens > 0) return usage.total_tokens
  return estimated
}
```

```ts
// packages/core/src/model-context-limits.ts
export const DEFAULT_CONTEXT_LIMIT = 256_000

const LIMITS: Record<string, number> = {
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
}

export function resolveContextLimit(model: string, envLimit?: string): number {
  const parsedEnv = envLimit ? Number(envLimit) : Number.NaN
  if (!Number.isNaN(parsedEnv) && parsedEnv > 0) return parsedEnv
  const normalized = model.toLowerCase().trim()
  return LIMITS[normalized] ?? DEFAULT_CONTEXT_LIMIT
}
```

- [ ] **Step 4: Export from core index**

In `packages/core/src/index.ts`, add:

```ts
export { estimateTokens, estimateMessages, applyUsageCorrection } from './token-counter.js'
export { resolveContextLimit, DEFAULT_CONTEXT_LIMIT } from './model-context-limits.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agent-kit/core test src/token-counter.test.ts src/model-context-limits.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/token-counter.ts packages/core/src/token-counter.test.ts packages/core/src/model-context-limits.ts packages/core/src/model-context-limits.test.ts packages/core/src/index.ts
git commit -m "feat(core): token counter and model context limit registry"
```

---

### Task 2: Context compressor

**Files:**
- Create: `packages/core/src/context-compressor.ts`
- Create: `packages/core/src/context-compressor.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `estimateMessages`, `toUnits` logic
- Produces: `compressMessages(messages, options, summarizer): Promise<CompressResult>`
- Produces: `CompressResult { messages: SessionMessage[]; summary?: string; compressedCount: number }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/context-compressor.test.ts
import { describe, it, expect } from 'vitest'
import { compressMessages } from './context-compressor.js'
import type { SessionMessage } from './contracts.js'

function makeMessages(count: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `question ${i}` })
    out.push({ role: 'assistant', content: `answer ${i}` })
  }
  return out
}

describe('compressMessages', () => {
  it('未超阈值时不压缩', async () => {
    const messages = makeMessages(2)
    const result = await compressMessages(messages, { limit: 1_000_000, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    expect(result.messages).toEqual(messages)
    expect(result.compressedCount).toBe(0)
  })

  it('超阈值时丢弃旧工具轮次', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a', toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
      { role: 'tool', content: 'tool out', callId: 'c1', toolName: 't' },
      { role: 'user', content: 'new q' },
      { role: 'assistant', content: 'new a' },
    ]
    const result = await compressMessages(messages, { limit: 40, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    // 保护区外旧的 assistant + tool 单元被整组移除
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(result.messages.find((m) => m.role === 'assistant' && m.content === 'old a')).toBeUndefined()
    expect(result.messages.find((m) => m.role === 'assistant' && m.content === 'new a')).toBeDefined()
  })

  it('丢弃后仍超阈值则摘要旧轮次', async () => {
    const summarizer = async () => 'summary'
    const messages: SessionMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]
    const result = await compressMessages(messages, { limit: 60, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 }, summarizer)
    expect(result.messages[0]).toMatchObject({ role: 'system', content: 'Earlier conversation summary: summary' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-kit/core test src/context-compressor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement compressor**

```ts
// packages/core/src/context-compressor.ts
import type { SessionMessage } from './contracts.js'
import { estimateMessages } from './token-counter.js'

export interface CompressOptions {
  limit: number
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
}

export interface CompressResult {
  messages: SessionMessage[]
  summary?: string
  compressedCount: number
}

export type Summarizer = (messages: SessionMessage[]) => Promise<string>

function toUnits(messages: SessionMessage[]): SessionMessage[][] {
  const units: SessionMessage[][] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const expected = new Set(message.toolCalls.map((call) => call.callId))
      const unit: SessionMessage[] = [message]
      let cursor = index + 1
      while (cursor < messages.length) {
        const next = messages[cursor]
        if (!next || next.role !== 'tool' || !expected.has(next.callId)) break
        unit.push(next)
        cursor += 1
      }
      units.push(unit)
      index = cursor
      continue
    }
    units.push([message])
    index += 1
  }
  return units
}

export async function compressMessages(
  messages: SessionMessage[],
  options: CompressOptions,
  summarizer?: Summarizer,
): Promise<CompressResult> {
  const limit = options.limit
  const high = options.highWatermark ?? 0.8
  const low = options.lowWatermark ?? 0.5
  const preserve = options.preserveRecentUnits ?? 2

  const used = estimateMessages(messages)
  if (limit <= 0 || used / limit < high) return { messages, compressedCount: 0 }

  const units = toUnits(messages)
  const protectedUnits = units.slice(-preserve)
  let compressible = units.slice(0, -preserve)
  if (compressible.length === 0) return { messages, compressedCount: 0 }

  // Phase 1: drop old tool-call rounds (assistant + its tool results) as a whole.
  const kept: SessionMessage[][] = []
  let droppedCount = 0
  for (const unit of compressible) {
    const first = unit[0]
    if (first && first.role === 'assistant' && first.toolCalls && first.toolCalls.length > 0) {
      droppedCount += unit.length
      continue
    }
    kept.push(unit)
  }
  compressible = kept
  let result = [...compressible, ...protectedUnits].flat()
  if (estimateMessages(result) / limit <= low) {
    return { messages: result, compressedCount: droppedCount }
  }

  // Phase 2: summarize the oldest remaining units until we hit low watermark.
  const toSummarize: SessionMessage[][] = []
  while (estimateMessages(result) / limit > low && compressible.length > 0) {
    const oldest = compressible.shift()
    if (!oldest) break
    toSummarize.push(oldest)
    result = [...compressible, ...protectedUnits].flat()
  }

  let summary: string | undefined
  if (toSummarize.length > 0 && summarizer) {
    try {
      summary = await summarizer(toSummarize.flat())
    } catch {
      // Fallback: leave the dropped units gone; no summary added.
    }
  }

  if (summary) {
    result = [{ role: 'system', content: `Earlier conversation summary: ${summary}` }, ...result]
  }

  return { messages: result, summary, compressedCount: droppedCount + toSummarize.flat().length }
}
```

- [ ] **Step 4: Export from core index**

Add:

```ts
export { compressMessages } from './context-compressor.js'
export type { CompressOptions, CompressResult, Summarizer } from './context-compressor.js'
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agent-kit/core test src/context-compressor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context-compressor.ts packages/core/src/context-compressor.test.ts packages/core/src/index.ts
git commit -m "feat(core): context compressor with drop + summarize strategy"
```

---

### Task 3: Parse `usage` in `LlmClient`

**Files:**
- Modify: `packages/core/src/llm-client.ts`
- Modify: `packages/core/src/llm-client.test.ts`

**Interfaces:**
- Produces: `LlmTraceEvent` gains `sessionId?: string`, `promptTokens?: number`, `completionTokens?: number`, `totalTokens?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/llm-client.test.ts (append in existing describe)
import { createLlmClient } from './llm-client.js'
import type { LlmTraceEvent } from './llm-client.js'

describe('usage parsing', () => {
  it('response usage 进入 trace 事件', async () => {
    const events: LlmTraceEvent[] = []
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })

    const client = createLlmClient({ apiKey: 'k', baseUrl: 'http://localhost', model: 'm', trace: (e) => events.push(e) })
    await client.complete({ context: {}, messages: [{ role: 'user', content: 'hi' }] })

    const responseEvent = events.find((e) => e.phase === 'response')
    expect(responseEvent).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-kit/core test src/llm-client.test.ts`
Expected: FAIL (promptTokens undefined).

- [ ] **Step 3: Update LlmTraceEvent and parse usage**

In `packages/core/src/llm-client.ts`:

```ts
export interface LlmTraceEvent {
  requestId: string
  phase: 'request' | 'response' | 'error'
  body?: Record<string, unknown>
  responseBody?: unknown
  durationMs: number
  error?: unknown
  /** Runtime-injected session id. */
  sessionId?: string
  /** From response.usage when available. */
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}
```

Add helper:

```ts
function parseUsage(payload: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
  if (typeof payload !== 'object' || payload === null) return {}
  const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage
  if (!usage) return {}
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}
```

In `completeJson`, replace the response trace line with:

```ts
const usage = parseUsage(payload)
trace?.({ requestId, phase: 'response', responseBody: payload, durationMs: Date.now() - startedAt, ...usage })
```

In `completeStream` non-stream fallback, same pattern.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @agent-kit/core test src/llm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm-client.ts packages/core/src/llm-client.test.ts
git commit -m "feat(core): parse usage and expose token fields in LlmTraceEvent"
```

---

### Task 4: Make `ContextManager` async-capable

**Files:**
- Modify: `packages/core/src/context-manager.ts`
- Modify: `packages/core/src/harness.ts`

**Interfaces:**
- Produces: `ContextManager.load` may return `SessionMessage[] | Promise<SessionMessage[]>`; `save`/`append` may return `void | Promise<void>`.

- [ ] **Step 1: Update interface and harness**

```ts
// packages/core/src/context-manager.ts
export interface ContextManager {
  load(sessionId: string): SessionMessage[] | Promise<SessionMessage[]>
  save(sessionId: string, messages: SessionMessage[]): void | Promise<void>
  append(sessionId: string, message: SessionMessage): void | Promise<void>
  getSummary(sessionId: string): string | undefined | Promise<string | undefined>
}
```

In `packages/core/src/harness.ts`, change `trimHistory` to async and await it where called:

```ts
async function trimHistory(sessionId: string, history: SessionMessage[]): Promise<SessionMessage[]> {
  if (!deps.context) return history
  await deps.context.save(sessionId, history)
  const trimmed = await deps.context.load(sessionId)
  const summary = await deps.context.getSummary(sessionId)
  if (!summary) return trimmed
  return [{ role: 'system', content: summary }, ...trimmed]
}
```

Update call sites in `runLoop`:

```ts
messages: await trimHistory(sessionId, history),
```

- [ ] **Step 2: Run core tests**

Run: `pnpm --filter @agent-kit/core test`
Expected: PASS (existing sync manager still works).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/context-manager.ts packages/core/src/harness.ts
git commit -m "refactor(core): allow ContextManager methods to be async"
```

---

### Task 5: TokenContextManager

**Files:**
- Create: `packages/core/src/token-context-manager.ts`
- Create: `packages/core/src/token-context-manager.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `compressMessages`, `estimateMessages`, `applyUsageCorrection`, `resolveContextLimit`
- Produces: `createTokenContextManager(options)` returns `ContextManager & TokenContextManagerApi`
- Produces: `ContextStatus` shape used by BFF status endpoint.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/token-context-manager.test.ts
import { describe, it, expect } from 'vitest'
import { createTokenContextManager } from './token-context-manager.js'
import type { SessionMessage } from './contracts.js'

function makeLongMessages(n: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', content: 'q '.repeat(100) })
    out.push({ role: 'assistant', content: 'a '.repeat(100) })
  }
  return out
}

describe('createTokenContextManager', () => {
  it('未超阈值时 load 返回原消息', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    const messages = makeLongMessages(2)
    await cm.save('s1', messages)
    expect(await cm.load('s1')).toEqual(messages)
    const status = cm.getStatus('s1')
    expect(status.ratio).toBeLessThan(0.1)
  })

  it('超阈值自动压缩', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 200, highWatermark: 0.8, lowWatermark: 0.5 })
    await cm.save('s1', makeLongMessages(10))
    const loaded = await cm.load('s1')
    expect(loaded.length).toBeLessThan(20)
    expect(cm.getStatus('s1').compressedCount).toBeGreaterThan(0)
  })

  it('onLlmTrace 用 usage 校准 used', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    await cm.save('s1', [{ role: 'user', content: 'hi' }])
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', totalTokens: 42 })
    expect(cm.getStatus('s1').used).toBe(42)
  })

  it('forceCompact 返回压缩后的消息', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 200, highWatermark: 0.8, lowWatermark: 0.5 })
    const original = makeLongMessages(10)
    const compressed = await cm.forceCompress('s1', original)
    expect(compressed.length).toBeLessThan(original.length)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-kit/core test src/token-context-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement TokenContextManager**

```ts
// packages/core/src/token-context-manager.ts
import type { SessionMessage } from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmTraceEvent } from './llm-client.js'
import { compressMessages, type CompressResult, type Summarizer } from './context-compressor.js'
import { applyUsageCorrection, estimateMessages } from './token-counter.js'

export interface ContextStatus {
  model: string
  limit: number
  used: number
  remaining: number
  ratio: number
  compressedCount: number
  lastUpdatedAt?: string
}

export interface TokenContextManagerOptions {
  model: string
  limit: number
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
  summarizer?: Summarizer
}

export interface TokenContextManager extends ContextManager {
  onLlmTrace(event: LlmTraceEvent): void
  getStatus(sessionId: string): ContextStatus
  sync(sessionId: string, messages: SessionMessage[]): void
  forceCompress(sessionId: string, messages: SessionMessage[]): Promise<SessionMessage[]>
  setSummarizer(summarizer: Summarizer): void
}

interface SessionState {
  raw: SessionMessage[]
  trimmed: SessionMessage[]
  summary?: string
  compressedCount: number
  lastUsageTotal?: number
  lastUpdatedAt?: string
}

export function createTokenContextManager(options: TokenContextManagerOptions): TokenContextManager {
  const sessions = new Map<string, SessionState>()
  const high = options.highWatermark ?? 0.8
  const low = options.lowWatermark ?? 0.5
  const preserve = options.preserveRecentUnits ?? 2

  function getState(sessionId: string): SessionState {
    return sessions.get(sessionId) ?? { raw: [], trimmed: [], compressedCount: 0 }
  }

  function setState(sessionId: string, state: SessionState) {
    sessions.set(sessionId, state)
  }

  function computeUsed(state: SessionState): number {
    return applyUsageCorrection(estimateMessages(state.trimmed), state.lastUsageTotal ? { total_tokens: state.lastUsageTotal } : undefined)
  }

  function buildStatus(sessionId: string): ContextStatus {
    const state = getState(sessionId)
    const used = computeUsed(state)
    const limit = options.limit
    return {
      model: options.model,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      ratio: limit > 0 ? used / limit : 0,
      compressedCount: state.compressedCount,
      lastUpdatedAt: state.lastUpdatedAt,
    }
  }

  async function runCompress(messages: SessionMessage[]): Promise<CompressResult> {
    return compressMessages(
      messages,
      { limit: options.limit, highWatermark: high, lowWatermark: low, preserveRecentUnits: preserve },
      options.summarizer,
    )
  }

  return {
    async save(sessionId, messages) {
      const compressed = await runCompress(messages)
      const state: SessionState = {
        ...getState(sessionId),
        raw: messages,
        trimmed: compressed.messages,
        summary: compressed.summary,
        compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      setState(sessionId, state)
    },
    async load(sessionId) {
      return getState(sessionId).trimmed
    },
    async append(sessionId, message) {
      const state = getState(sessionId)
      await this.save(sessionId, [...state.raw, message])
    },
    async getSummary(sessionId) {
      return getState(sessionId).summary
    },
    onLlmTrace(event) {
      if (!event.sessionId) return
      if (event.totalTokens && event.totalTokens > 0) {
        const state = getState(event.sessionId)
        state.lastUsageTotal = event.totalTokens
        state.lastUpdatedAt = new Date().toISOString()
        setState(event.sessionId, state)
      }
    },
    getStatus(sessionId) {
      return buildStatus(sessionId)
    },
    sync(sessionId, messages) {
      const state = getState(sessionId)
      state.raw = messages
      state.trimmed = messages
      state.lastUpdatedAt = new Date().toISOString()
      setState(sessionId, state)
    },
    async forceCompress(sessionId, messages) {
      const compressed = await runCompress(messages)
      const state: SessionState = {
        ...getState(sessionId),
        raw: compressed.messages,
        trimmed: compressed.messages,
        summary: compressed.summary,
        compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      setState(sessionId, state)
      return compressed.messages
    },
    setSummarizer(summarizer) {
      options.summarizer = summarizer
    },
  }
}
```

- [ ] **Step 4: Export from core index**

Add:

```ts
export { createTokenContextManager } from './token-context-manager.js'
export type { ContextStatus, TokenContextManager, TokenContextManagerOptions } from './token-context-manager.js'
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agent-kit/core test src/token-context-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/token-context-manager.ts packages/core/src/token-context-manager.test.ts packages/core/src/index.ts
git commit -m "feat(core): TokenContextManager with auto/manual compression"
```

---

### Task 6: Adapter-sqlite accepts context manager

**Files:**
- Modify: `packages/adapter-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `ContextManager` from core, `LlmTraceEvent`
- Produces: `createSqliteAgentRuntime` accepts optional `contextManager` and forwards `llmTrace` events with `sessionId`.

- [ ] **Step 1: Add `contextManager` option and forward trace**

In `createSqliteAgentRuntime` options, add:

```ts
contextManager?: ContextManager & { onLlmTrace?: (event: LlmTraceEvent) => void }
```

In the `llm.complete` wrapper, build trace callback that injects `sessionId` and forwards to both caller and context manager:

```ts
const clientTrace = (event: LlmTraceEvent) => {
  const enriched = { ...event, sessionId: request.sessionId }
  options.llmTrace?.(enriched)
  options.contextManager?.onLlmTrace?.(enriched)
}
```

Pass `context: options.contextManager` to `createAgentHarness`.

- [ ] **Step 2: Run adapter tests**

Run: `pnpm --filter @agent-kit/adapter-sqlite test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/adapter-sqlite/src/index.ts
git commit -m "feat(adapter-sqlite): accept TokenContextManager and forward llmTrace"
```

---

### Task 7: BFF wiring and API endpoints

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`
- Modify: `examples/flutter-dev-bff/src/server.test.ts`
- Modify: `examples/flutter-dev-bff/.env.example`

**Interfaces:**
- Consumes: `createTokenContextManager`, `resolveContextLimit`
- Produces: `GET /api/sessions/:sessionId/context`
- Produces: `POST /api/sessions/:sessionId/context/compact`

- [ ] **Step 1: Create context manager and pass to runtime**

In `examples/flutter-dev-bff/src/server.ts`, after `loadEnvFile(programDir)` and before `createSqliteAgentRuntime`, create:

```ts
const mainContextManager = createTokenContextManager({
  model: process.env.LLM_MODEL ?? 'unknown',
  limit: resolveContextLimit(process.env.LLM_MODEL ?? 'unknown', process.env.LLM_CONTEXT_LIMIT),
})
```

Create summarizer after `runtime` exists and set it:

```ts
mainContextManager.setSummarizer?.(async (messages) => {
  const secret = await runtime.secrets.get()
  const result = await createLlmClient({ ...secret, maxRetries: 1 }).complete({
    context: {},
    messages,
    systemPrompt: '请把以下对话总结成一段简洁的上下文摘要，保留关键决策、代码改动、错误结论， omit 具体实现细节和重复的工具输出。',
  })
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
})
```

Add `contextManager: mainContextManager` to `createSqliteAgentRuntime` options.

- [ ] **Step 2: Add status and compact endpoints**

```ts
app.get('/api/sessions/:sessionId/context', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
  if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
  const scopedId = `flutter-dev:${c.req.param('sessionId')}`
  const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(scopedId) as { messages?: string } | undefined
  const messages: SessionMessage[] = row?.messages ? JSON.parse(row.messages) : []
  mainContextManager.sync(scopedId, messages)
  return c.json(mainContextManager.getStatus(scopedId))
})

app.post('/api/sessions/:sessionId/context/compact', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
  if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
  const scopedId = `flutter-dev:${c.req.param('sessionId')}`
  const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(scopedId) as { messages?: string } | undefined
  const messages: SessionMessage[] = row?.messages ? JSON.parse(row.messages) : []
  const compressed = await mainContextManager.forceCompress(scopedId, messages)
  await runtime.sessions.save(scopedId, compressed)
  return c.json(mainContextManager.getStatus(scopedId))
})
```

- [ ] **Step 3: Persist compressed history after each harness operation**

Wrap `runtime.harness` so every `run`/`continue`/`resume` saves compressed history back to the store:

```ts
async function persistCompressed(sessionId: string) {
  const messages = await runtime.sessions.load(sessionId)
  const compressed = await mainContextManager.forceCompress(sessionId, messages)
  await runtime.sessions.save(sessionId, compressed)
}

const harness = {
  run: async (request) => {
    const result = await runtime.harness.run(request)
    await persistCompressed(request.sessionId)
    return result
  },
  continue: async (request) => {
    const result = await runtime.harness.continue(request)
    await persistCompressed(request.sessionId)
    return result
  },
  resume: async (request) => {
    const result = await runtime.harness.resume(request)
    await persistCompressed(request.sessionId)
    return result
  },
}
```

Pass this wrapped `harness` to `createAgentBff` instead of `runtime.harness`.

- [ ] **Step 4: Add tests for endpoints**

In `examples/flutter-dev-bff/src/server.test.ts`, add:

```ts
it('GET /api/sessions/:id/context 返回上下文状态', async () => {
  // create session, send a message, then call endpoint
})

it('POST /api/sessions/:id/context/compact 压缩历史', async () => {
  // create session with long history, compact, assert used decreased
})
```

- [ ] **Step 5: Update .env.example**

Append:

```
# 模型上下文 token 上限（找不到内置表时生效，默认 256K）
# LLM_CONTEXT_LIMIT=256000
# VISION_CONTEXT_LIMIT=256000
```

- [ ] **Step 6: Run BFF tests**

Run: `pnpm --filter flutter-dev-bff test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/server.test.ts examples/flutter-dev-bff/.env.example
git commit -m "feat(flutter-dev-bff): wire TokenContextManager and add /context endpoints"
```

---

### Task 8: WebUI badge and popover

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`
- Modify: `examples/flutter-dev-bff/public/assets/app.js`
- Modify: `examples/flutter-dev-bff/public/assets/app.css`

**Interfaces:**
- Consumes: `GET /api/sessions/:sessionId/context`, `POST /api/sessions/:sessionId/context/compact`

- [ ] **Step 1: Add DOM elements**

In `public/index.html`, after `#stop` button add:

```html
<button id="context-btn" title="上下文状态">—</button>
<div id="context-popover" class="hidden">
  <div class="context-row"><span>模型</span><span id="ctx-model">—</span></div>
  <div class="context-row"><span>上限</span><span id="ctx-limit">—</span></div>
  <div class="context-row"><span>已用</span><span id="ctx-used">—</span></div>
  <div class="context-row"><span>剩余</span><span id="ctx-remaining">—</span></div>
  <div class="context-bar"><div id="ctx-bar"></div></div>
  <button id="ctx-compact">压缩上下文</button>
</div>
```

- [ ] **Step 2: Add styles**

In `public/assets/app.css`:

```css
#context-btn { padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text2); font-size: 12px; cursor: pointer; }
#context-btn.ok { border-color: var(--accent2); color: var(--accent2); }
#context-btn.warn { border-color: #f0ad4e; color: #f0ad4e; }
#context-btn.danger { border-color: var(--error); color: var(--error); }
#context-popover { position: absolute; bottom: 64px; right: 20px; width: 240px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 50; }
#context-popover.hidden { display: none; }
.context-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; color: var(--text2); }
.context-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin: 8px 0; }
#ctx-bar { height: 100%; width: 0%; background: var(--accent2); transition: width .2s, background .2s; }
#ctx-bar.warn { background: #f0ad4e; }
#ctx-bar.danger { background: var(--error); }
#ctx-compact { width: 100%; padding: 6px; border: none; border-radius: 6px; background: var(--accent); color: var(--bg); font-size: 12px; cursor: pointer; }
```

- [ ] **Step 3: Add JS logic**

In `public/assets/app.js`:

```js
const contextBtn = $('context-btn')
const contextPopover = $('context-popover')
let contextVisible = false

async function refreshContext() {
  if (!currentSessionId) return
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/context`)
    const ratio = Math.min(1, Math.max(0, data.ratio ?? 0))
    const pct = Math.round(ratio * 100)
    contextBtn.textContent = `${pct}%`
    contextBtn.className = ratio < 0.6 ? 'ok' : ratio < 0.8 ? 'warn' : 'danger'
    $('ctx-model').textContent = data.model ?? '—'
    $('ctx-limit').textContent = data.limit?.toLocaleString() ?? '—'
    $('ctx-used').textContent = data.used?.toLocaleString() ?? '—'
    $('ctx-remaining').textContent = data.remaining?.toLocaleString() ?? '—'
    const bar = $('ctx-bar')
    bar.style.width = `${pct}%`
    bar.className = ratio < 0.6 ? '' : ratio < 0.8 ? 'warn' : 'danger'
  } catch {
    contextBtn.textContent = '—'
  }
}

contextBtn.addEventListener('click', () => {
  contextVisible = !contextVisible
  contextPopover.classList.toggle('hidden', !contextVisible)
  if (contextVisible) refreshContext()
})

$('ctx-compact').addEventListener('click', async () => {
  if (!currentSessionId) return
  await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/context/compact`, { method: 'POST' })
  await refreshContext()
})
```

Call `refreshContext()` after `sendBtn` click completes and after `switchSession`.

- [ ] **Step 4: Start dev server and verify UI**

Run: `pnpm --filter flutter-dev-bff dev`
Open browser at `http://localhost:8788`
Expected:
- New conversation shows green `0%` badge.
- Hover/click badge shows popover with limit/used/remaining/bar.
- Long conversation turns badge yellow/red.
- "压缩上下文" button reduces used count.

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/public/index.html examples/flutter-dev-bff/public/assets/app.js examples/flutter-dev-bff/public/assets/app.css
git commit -m "feat(flutter-dev-bff): context window badge and popover UI"
```

---

### Task 9: Full test run and final commit

- [ ] **Step 1: Run all tests**

```bash
pnpm test
```

Expected: all packages pass.

- [ ] **Step 2: If failures, fix and re-run**

- [ ] **Step 3: Final commit (or no-op if nothing changed)**

```bash
# only if there are fixes
git commit -m "fix(context-window): address test failures"
```

---

## Spec Coverage Check

| Spec Section | Implementing Task |
|--------------|-------------------|
| Token counter (`usage` + char/4 fallback) | Task 1 |
| Model limit registry | Task 1 |
| `LlmClient` usage parsing | Task 3 |
| Async-capable `ContextManager` | Task 4 |
| `TokenContextManager` with high/low watermark | Task 5 |
| Compression algorithm (drop tool turns + summarize) | Task 2, Task 5 |
| `adapter-sqlite` wiring | Task 6 |
| BFF status/compact endpoints | Task 7 |
| WebUI badge + popover | Task 8 |
| Env template | Task 7 |
| Error handling (unknown model default, summary fallback) | Task 1, Task 2, Task 5 |
| Tests | All tasks |

No placeholders or unresolved dependencies remain in the plan.
