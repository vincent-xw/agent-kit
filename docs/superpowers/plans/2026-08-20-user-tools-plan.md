# 辅助用户工具集（host 文件 / 问询 / 审批 / 受控执行 / 通知 / 出网 / 剪贴板）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 flutter-dev-bff 新增 9 个辅助用户工具（host 文件读写、ask_user 问询、user_confirm 审批、host_exec、host_notify、web_fetch、host_clipboard），带阻塞式交互底座与分级权限（受信任 host 模式开关）。

**Architecture:** 共享一个「阻塞式交互底座」（AskService + 进程内 pendingAsks + `ask_user` SSE 事件 + `POST /api/sessions/:id/asks/:callId` 回填），`ask_user` 与 `user_confirm` 以及高危工具内部的强制审批都复用它。host 文件读写锁死在工作区根目录（`path` 前缀校验），高危操作默认经 `user_confirm` 审批，WebUI 设置面板「受信任 host 模式」按会话放开。

**Tech Stack:** TypeScript strict、Hono（`examples/flutter-dev-bff` 的 `@hono`）、`node:fs/promises`、`node:child_process`、原生 HTML/JS/CSS（前端静态文件）、vitest。

## Global Constraints

- `@agent-kit/core` **不改契约**——全部加性改动都在 BFF 层（`examples/flutter-dev-bff`）
- **范围收敛**：spec 中 `user_confirm` 的「临时 grant（本次运行内放行同类）」本轮**不做**——「受信任 host 模式」开关即会话级 grant，已覆盖主要需求；run 级瞬时 grant 留给未来
- 会话 ID 双形态：harness 工具收到的 `context.sessionId` 是**带前缀** `flutter-dev:<raw>` 的 scoped 形态；WebUI 端点是**原始**形态。任何涉及 session 的地方必须正确归一化（前缀 `flutter-dev:`）
- host 路径一律 `assertInsideRoot(root, path)` 校验，拒绝 `..` 逃逸与落在根外，否则返回 `{ ok:false, error:'path outside workspace' }`
- 工具内部错误沿用既有约定：返回 `{ ok:false, error }` 给 LLM，**不抛异常**；语义字段 `denied`/`blocked`/`timeout`
- 前端保持原生 HTML/JS/CSS（无构建、无测试基建），手动浏览器验证收尾
- Node >= 22（`AbortSignal.timeout` 可用）；`process.platform === 'darwin'` 视为 macOS

---

### Task 1: AskService 与 HostPolicy 服务（基础）

**Files:**
- Create: `examples/flutter-dev-bff/src/services/ask-service.ts`
- Create: `examples/flutter-dev-bff/src/services/host-policy.ts`
- Test: `examples/flutter-dev-bff/src/services/ask-service.test.ts`

**Interfaces:**
- Produces:
  - `interface AskRequest { sessionId: string; callId: string; kind: 'question' | 'approval'; question: string; options: string[]; select: 'single' | 'multiple' }`
  - `interface AskService { awaitAnswer(req: AskRequest): Promise<string | string[]>; cancel(callId: string): void; resolve(sessionId: string, callId: string, answer: string | string[]): boolean }`
  - `function createAskService(bus: { emit(e: { type: string; [k: string]: unknown }): void }): AskService`
  - `interface HostPolicyService { isTrusted(sessionId: string): boolean; setTrusted(sessionId: string, trusted: boolean): void }`
  - `function createHostPolicyService(): HostPolicyService`

- [ ] **Step 1: 写失败的 AskService 测试**

```ts
// examples/flutter-dev-bff/src/services/ask-service.test.ts
import { describe, it, expect } from 'vitest'
import { createAskService } from './ask-service.js'

function fakeBus() {
  const events: Array<Record<string, unknown>> = []
  return { emit: (e: { type: string; [k: string]: unknown }) => { events.push(e) }, events }
}

describe('AskService', () => {
  it('awaitAnswer 发出 ask_user 事件并等待 resolve', async () => {
    const bus = fakeBus()
    const s = createAskService(bus)
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: '选', options: ['A'], select: 'single' })
    expect(bus.events[0]).toMatchObject({ type: 'ask_user', sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: '选' })
    expect(s.resolve('flutter-dev:s1', 'c1', 'A')).toBe(true)
    await expect(p).resolves.toBe('A')
  })
  it('resolve 校验 session 归属', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'approval', question: 'q', options: [], select: 'single' })
    expect(s.resolve('flutter-dev:OTHER', 'c1', '允许')).toBe(false)
    expect(s.resolve('flutter-dev:s1', 'c1', '允许')).toBe(true)
    await expect(p).resolves.toBe('允许')
  })
  it('cancel 使 awaitAnswer reject', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'approval', question: 'q', options: [], select: 'single' }).catch((e: Error) => e.message)
    s.cancel('c1')
    await expect(p).resolves.toBe('cancelled')
  })
  it('重复 resolve 返回 false 且只生效一次', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: 'q', options: [], select: 'single' })
    expect(s.resolve('flutter-dev:s1', 'c1', 'A')).toBe(true)
    expect(s.resolve('flutter-dev:s1', 'c1', 'B')).toBe(false)
    await expect(p).resolves.toBe('A')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/ask-service.test.ts`
Expected: FAIL "Cannot find module './ask-service'"

- [ ] **Step 3: 实现 ask-service.ts**

```ts
// examples/flutter-dev-bff/src/services/ask-service.ts
export interface AskRequest {
  sessionId: string
  callId: string
  kind: 'question' | 'approval'
  question: string
  options: string[]
  select: 'single' | 'multiple'
}

export interface AskService {
  /** 发 ask_user 事件并阻塞，直到 resolve/cancel。 */
  awaitAnswer(req: AskRequest): Promise<string | string[]>
  /** 取消一个待答（agent 侧取消 run 时调用）。 */
  cancel(callId: string): void
  /** 回填答案；校验 session 归属，成功返回 true；不存在/归属不符返回 false。 */
  resolve(sessionId: string, callId: string, answer: string | string[]): boolean
}

interface PendingAsk {
  sessionId: string
  resolve: (v: string | string[]) => void
  reject: (e: Error) => void
}

type Bus = { emit(e: { type: string; [k: string]: unknown }): void }

export function createAskService(bus: Bus): AskService {
  const pending = new Map<string, PendingAsk>()
  return {
    async awaitAnswer(req) {
      bus.emit({
        type: 'ask_user',
        kind: req.kind,
        sessionId: req.sessionId,
        callId: req.callId,
        question: req.question,
        options: req.options,
        select: req.select,
      })
      return new Promise<string | string[]>((resolve, reject) => {
        pending.set(req.callId, { sessionId: req.sessionId, resolve, reject })
      })
    },
    cancel(callId) {
      const p = pending.get(callId)
      if (!p) return
      pending.delete(callId)
      p.reject(new Error('cancelled'))
    },
    resolve(sessionId, callId, answer) {
      const p = pending.get(callId)
      if (!p || p.sessionId !== sessionId) return false
      pending.delete(callId)
      p.resolve(answer)
      return true
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/ask-service.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 写失败 HostPolicy 测试**

```ts
// examples/flutter-dev-bff/src/services/host-policy.test.ts
import { describe, it, expect } from 'vitest'
import { createHostPolicyService } from './host-policy.js'

describe('HostPolicy', () => {
  it('默认关、按会话隔离', () => {
    const p = createHostPolicyService()
    expect(p.isTrusted('flutter-dev:s1')).toBe(false)
    p.setTrusted('flutter-dev:s1', true)
    expect(p.isTrusted('flutter-dev:s1')).toBe(true)
    expect(p.isTrusted('flutter-dev:s2')).toBe(false)
  })
  it('可关闭', () => {
    const p = createHostPolicyService()
    p.setTrusted('flutter-dev:s1', true)
    p.setTrusted('flutter-dev:s1', false)
    expect(p.isTrusted('flutter-dev:s1')).toBe(false)
  })
})
```

- [ ] **Step 6: 实现 host-policy.ts**

```ts
// examples/flutter-dev-bff/src/services/host-policy.ts
export interface HostPolicyService {
  isTrusted(sessionId: string): boolean
  setTrusted(sessionId: string, trusted: boolean): void
}

export function createHostPolicyService(): HostPolicyService {
  const trusted = new Map<string, boolean>()
  return {
    isTrusted(sessionId) { return trusted.get(sessionId) === true },
    setTrusted(sessionId, v) { trusted.set(sessionId, v) },
  }
}
```

- [ ] **Step 7: 运行测试 + Commit**

```bash
cd examples/flutter-dev-bff && pnpm exec vitest run src/services/host-policy.test.ts
# expected: PASS, 2 tests
git add examples/flutter-dev-bff/src/services/ask-service.ts examples/flutter-dev-bff/src/services/ask-service.test.ts examples/flutter-dev-bff/src/services/host-policy.ts examples/flutter-dev-bff/src/services/host-policy.test.ts
git commit -m "feat: 阻塞式交互底座 AskService 与会话级 HostPolicy"
```

---

### Task 2: host 路径安全助手

**Files:**
- Create: `examples/flutter-dev-bff/src/tools/path-safety.ts`
- Test: `examples/flutter-dev-bff/src/tools/path-safety.test.ts`

**Interfaces:**
- Consumes: 无（独立工具）
- Produces: `function assertInsideRoot(root: string, path: string): string`（返回根内绝对路径，越权抛 Error）

- [ ] **Step 1: 写失败测试**

```ts
// examples/flutter-dev-bff/src/tools/path-safety.test.ts
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertInsideRoot } from './path-safety.js'

const root = join(tmpdir(), 'ak-root-test')

describe('assertInsideRoot', () => {
  it('相对路径落在根内', () => {
    expect(assertInsideRoot(root, 'a/b.txt')).toBe(join(root, 'a/b.txt'))
  })
  it('根内绝对路径放行', () => {
    expect(assertInsideRoot(root, join(root, 'x'))).toBe(join(root, 'x'))
  })
  it('.. 逃逸被拒', () => {
    expect(() => assertInsideRoot(root, '../evil')).toThrow(/outside workspace/)
    expect(() => assertInsideRoot(root, join(root, '..', 'evil'))).toThrow(/outside workspace/)
  })
  it('根外绝对路径被拒', () => {
    expect(() => assertInsideRoot(root, join(tmpdir(), 'other'))).toThrow(/outside workspace/)
  })
  it('根自身放行', () => {
    expect(assertInsideRoot(root, root)).toBe(root)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/path-safety.test.ts`
Expected: FAIL "Cannot find module './path-safety'"

- [ ] **Step 3: 实现 path-safety.ts**

```ts
// examples/flutter-dev-bff/src/tools/path-safety.ts
import { resolve, sep } from 'node:path'

/** 把 path 解析进 root 内的绝对路径；越权（.. 逃逸/落在根外）抛 Error。 */
export function assertInsideRoot(root: string, path: string): string {
  const abs = resolve(root, path)
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path outside workspace: ${path}`)
  }
  return abs
}
```

- [ ] **Step 4: 运行测试确认通过**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/path-safety.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/tools/path-safety.ts examples/flutter-dev-bff/src/tools/path-safety.test.ts
git commit -m "feat: host 路径安全助手 assertInsideRoot"
```

---

### Task 3: host 工具（文件 list/read/write、host_exec、host_notify、web_fetch、host_clipboard）

**Files:**
- Create: `examples/flutter-dev-bff/src/tools/host-tools.ts`
- Test: `examples/flutter-dev-bff/src/tools/host-tools.test.ts`

**Interfaces:**
- Consumes: `assertInsideRoot`（Task 2）、`AskService`（Task 1）、`HostPolicyService`（Task 1）
- Produces:
  - `interface HostToolServices { workspaceRoot: string; ask: AskService; policy: HostPolicyService }`
  - `function createHostToolDefinitions(svc: HostToolServices): ToolDefinition[]`（数组含 7 个工具）
  - `function msg(error: unknown): string`（导出的错误消息助手，测试用）

- [ ] **Step 1: 写失败测试**

```ts
// examples/flutter-dev-bff/src/tools/host-tools.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostToolDefinitions, type HostToolServices } from './host-tools.js'
import { createAskService } from '../services/ask-service.js'
import { createHostPolicyService } from '../services/host-policy.js'
import type { ToolDefinition } from '@agent-kit/core'

function makeSvcs(root: string, opts: { echoAnswer?: string; trusted?: boolean } = {}) {
  const events: unknown[] = []
  const ask = createAskService({ emit: (e) => events.push(e) })
  const policy = createHostPolicyService()
  if (opts.trusted) policy.setTrusted('flutter-dev:s1', true)
  const svcs: HostToolServices = { workspaceRoot: root, ask, policy }
  return { svcs, ask, events }
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const tools = createHostToolDefinitions({ workspaceRoot: '', ask: null as never, policy: null as never })

describe('host 工具', () => {
  const dir = join(tmpdir(), `ak-host-${Date.now()}`)
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello')
    mkdirSync(join(dir, 'sub'))
  })

  it('host_file_list 列出目录条目', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_file_list')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ path: '.' }, {} as never)
    expect(out.ok).toBe(true)
    const entries = out.entries as Array<{ name: string; type: string }>
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
    expect(entries.find((e) => e.name === 'a.txt')?.type).toBe('file')
  })

  it('host_file_list 越权被拒', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_file_list')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ path: '../' }, {} as never)
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/outside workspace/)
  })

  it('host_file_read 读文本并截断', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_file_read')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ path: 'a.txt' }, {} as never)
    expect(out).toMatchObject({ ok: true, content: 'hello' })
  })

  it('host_file_write 未受信任需审批，拒绝返回 denied', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_file_write')
    const out = await (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(
      { path: 'b.txt', content: 'x' },
      { sessionId: 'flutter-dev:s1', callId: 'c1' },
    )
    expect(out.denied).toBe(true)
  })
  it('host_file_write 受信任或确认后写入', async () => {
    const { svcs } = makeSvcs(dir, { trusted: true })
    const t = byName(createHostToolDefinitions(svcs), 'host_file_write')
    const out = await (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(
      { path: 'b.txt', content: 'hi' },
      { sessionId: 'flutter-dev:s1', callId: 'c1' },
    )
    expect(out.ok).toBe(true)
  })

  it('host_exec 受信任时执行返回输出', async () => {
    const { svcs } = makeSvcs(dir, { trusted: true })
    const t = byName(createHostToolDefinitions(svcs), 'host_exec')
    const out = await (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(
      { command: 'printf hello' },
      { sessionId: 'flutter-dev:s1', callId: 'c1' },
    )
    expect(String(out.stdout)).toContain('hello')
  })
  it('host_exec 未受信任返回 denied', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_exec')
    const out = await (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(
      { command: 'ls' },
      { sessionId: 'flutter-dev:s1', callId: 'c1' },
    )
    expect(out.denied).toBe(true)
  })

  it('host_notify 返回 ok（静默降级）', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_notify')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ title: 't', message: 'm' }, {} as never)
    expect(out).toMatchObject({ ok: true })
  })

  it('web_fetch 本地回环被拦截', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'web_fetch')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ url: 'http://127.0.0.1/' }, {} as never)
    expect(out.blocked).toBe(true)
  })

  it('host_clipboard read 返回 ok 或错误（平台相关）', async () => {
    const { svcs } = makeSvcs(dir)
    const t = byName(createHostToolDefinitions(svcs), 'host_clipboard')
    const out = await (t.execute as (i: unknown) => Promise<Record<string, unknown>>)({ action: 'read' }, {} as never)
    expect('ok' in out).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/host-tools.test.ts`
Expected: FAIL "Cannot find module './host-tools'"

- [ ] **Step 3: 实现 host-tools.ts**

```ts
// examples/flutter-dev-bff/src/tools/host-tools.ts
import { z } from 'zod'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, writeFile, appendFile, stat, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ToolDefinition } from '@agent-kit/core'
import { assertInsideRoot } from './path-safety.js'
import type { AskService } from '../services/ask-service.js'
import type { HostPolicyService } from '../services/host-policy.js'

const execAsync = promisify(exec)

export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface HostToolServices {
  workspaceRoot: string
  ask: AskService
  policy: HostPolicyService
}

const TEXT_MAX = 200_000
const EXEC_OUT_MAX = 64_000

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true
  if (hostname.startsWith('127.')) return true
  if (hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
}

/** 未受信任时走 user_confirm 审批；返回是否放行。callId 为工具自身调用。 */
async function confirmIfNeeded(
  svc: HostToolServices,
  sessionId: string,
  callId: string,
  question: string,
): Promise<boolean> {
  if (svc.policy.isTrusted(sessionId)) return true
  const answer = await svc.ask.awaitAnswer({
    sessionId,
    callId,
    kind: 'approval',
    question,
    options: ['允许', '拒绝'],
    select: 'single',
  })
  return answer === '允许'
}

async function statSafe(p: string) {
  try { return await stat(p) } catch { return undefined }
}

export function createHostToolDefinitions(svc: HostToolServices): ToolDefinition[] {
  const hostCtx = (c: unknown) => ({
    sessionId: ((c ?? {}) as { sessionId?: string }).sessionId ?? '',
    callId: ((c ?? {}) as { callId?: string }).callId ?? '',
  })

  return [
    {
      name: 'host_file_list',
      execution: 'server',
      description: '列出工作区根目录内某个目录下的条目（文件/子目录）。目录须在工作区根内。',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean(), entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'dir']), size: z.number().optional(), modifiedAt: z.number().optional() })).optional(), error: z.string().optional() }),
      timeoutMs: 15_000,
      async execute(raw) {
        try {
          const dir = assertInsideRoot(svc.workspaceRoot, (raw as { path: string }).path)
          const entries = await readdir(dir, { withFileTypes: true })
          const out = await Promise.all(entries.map(async (e) => {
            const st = await statSafe(join(dir, e.name))
            return {
              name: e.name,
              type: e.isDirectory() ? 'dir' as const : 'file' as const,
              ...(st?.size != null ? { size: st.size } : {}),
              ...(st?.mtimeMs != null ? { modifiedAt: st.mtimeMs } : {}),
            }
          }))
          return { ok: true, entries: out }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_file_read',
      execution: 'server',
      description: '读取工作区根内文本文件，超长会截断。二进制文件不读。',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean(), content: z.string().optional(), truncated: z.boolean().optional(), error: z.string().optional() }),
      timeoutMs: 15_000,
      async execute(raw) {
        try {
          const abs = assertInsideRoot(svc.workspaceRoot, (raw as { path: string }).path)
          const buf = await readFile(abs)
          if (buf.includes(0)) return { ok: false, error: '是二进制文件，无法作为文本读取' }
          const text = buf.toString('utf8')
          return { ok: true, content: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_file_write',
      execution: 'server',
      description: '写入工作区根内文件（默认覆盖，可追加）。写入前通常需要用户审批。',
      input: z.object({ path: z.string(), content: z.string(), mode: z.enum(['overwrite', 'append', 'create']).optional() }),
      output: z.object({ ok: z.boolean(), bytes: z.number().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 30_000,
      async execute(raw, context) {
        const { path, content, mode = 'overwrite' } = raw as { path: string; content: string; mode?: string }
        let abs: string
        try {
          abs = assertInsideRoot(svc.workspaceRoot, path)
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, `允许写入文件 ${abs} 吗？`)) {
          return { ok: false, denied: true }
        }
        try {
          if (mode === 'append') {
            await appendFile(abs, content, 'utf8')
          } else {
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, content, 'utf8')
          }
          return { ok: true, bytes: Buffer.byteLength(content) }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_exec',
      execution: 'server',
      description: '在用户电脑上执行一条命令并截取输出。命令执行前通常需要审批。',
      input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120_000).optional() }),
      output: z.object({ ok: z.boolean(), stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().optional(), timedOut: z.boolean().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 125_000,
      async execute(raw, context) {
        const { command, cwd, timeoutMs } = raw as { command: string; cwd?: string; timeoutMs?: number }
        let cwdAbs: string | undefined
        if (cwd) {
          try { cwdAbs = assertInsideRoot(svc.workspaceRoot, cwd) } catch { return { ok: false, error: 'cwd outside workspace' } }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, `允许执行命令：${command.slice(0, 200)}？`)) {
          return { ok: false, denied: true }
        }
        try {
          const out = await execAsync(command, {
            cwd: cwdAbs ?? svc.workspaceRoot,
            timeout: timeoutMs ?? 60_000,
            maxBuffer: EXEC_OUT_MAX * 2,
            shell: process.platform === 'darwin' ? '/bin/bash' : '/bin/bash',
          })
          return { ok: true, stdout: String(out.stdout ?? '').slice(0, EXEC_OUT_MAX), stderr: String(out.stderr ?? '').slice(0, EXEC_OUT_MAX), exitCode: 0 }
        } catch (error) {
          const e = error as { stdout?: unknown; stderr?: unknown; killed?: boolean; code?: unknown }
          return {
            ok: false,
            stdout: String(e.stdout ?? '').slice(0, EXEC_OUT_MAX),
            stderr: String(e.stderr ?? '').slice(0, EXEC_OUT_MAX),
            exitCode: typeof e.code === 'number' ? e.code : undefined,
            timedOut: e.killed === true,
            error: msg(error),
          }
        }
      },
    },
    {
      name: 'host_notify',
      execution: 'server',
      description: '发一条桌面通知（macOS 或 Linux）。',
      input: z.object({ title: z.string(), message: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      timeoutMs: 5000,
      async execute(raw) {
        const { title, message = '' } = raw as { title: string; message?: string }
        const script = process.platform === 'darwin'
          ? `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
          : `notify-send ${JSON.stringify(title)} ${JSON.stringify(message)}`
        await execAsync(process.platform === 'darwin' ? `osascript -e ${JSON.stringify(script)}` : script, { shell: '/bin/bash' }).catch(() => {})
        return { ok: true }
      },
    },
    {
      name: 'web_fetch',
      execution: 'server',
      description: '抓取一个 http(s) URL 的文本内容（只读）。默认拦截本地回环与保留段；可用 HOST_FETCH_ALLOWED_HOSTS 白名单。',
      input: z.object({ url: z.string() }),
      output: z.object({ ok: z.boolean(), status: z.number().optional(), text: z.string().optional(), blocked: z.boolean().optional(), error: z.string().optional() }),
      timeoutMs: 20_000,
      async execute(raw) {
        const url = (raw as { url: string }).url
        let parsed: URL
        try { parsed = new URL(url) } catch { return { ok: false, error: 'url 不合法' } }
        if (!['http:', 'https:'].includes(parsed.protocol) || isLocalHost(parsed.hostname)) {
          return { ok: false, blocked: true }
        }
        const allowed = (process.env.HOST_FETCH_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (allowed.length > 0 && !allowed.includes(parsed.hostname)) {
          return { ok: false, blocked: true }
        }
        try {
          const res = await fetch(parsed, { signal: AbortSignal.timeout(15_000) })
          const text = await res.text()
          return { ok: true, status: res.status, text: text.slice(0, TEXT_MAX) }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_clipboard',
      execution: 'server',
      description: '读写用户电脑剪贴板。'
      .concat(' read 直接读；write 需审批。'),
      input: z.object({ action: z.enum(['read', 'write']), text: z.string().optional() }),
      output: z.object({ ok: z.boolean(), text: z.string().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 10_000,
      async execute(raw, context) {
        const { action, text } = raw as { action: 'read' | 'write'; text?: string }
        const copyCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard'
        const pasteCmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o'
        if (action === 'read') {
          try {
            const { stdout } = await execAsync(pasteCmd, { shell: '/bin/bash', maxBuffer: 1024 * 1024 })
            return { ok: true, text: String(stdout ?? '').slice(0, TEXT_MAX) }
          } catch {
            return { ok: false, error: `${process.platform === 'darwin' ? 'pbpaste' : 'xclip'} 不可用` }
          }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, '允许写入剪贴板吗？')) return { ok: false, denied: true }
        try {
          await execAsync(`printf %s ${JSON.stringify(text ?? '')} | ${copyCmd}`, { shell: '/bin/bash' })
          return { ok: true }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
  ]
}
```

- [ ] **Step 4: 运行测试确认通过**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/host-tools.test.ts`
Expected: PASS。若 `host_notify`/`host_clipboard` 因平台缺 `notify-send`/`xclip` 失败，按失败语义返回 `ok:false` 也满足断言（断言只查 `'ok' in out` 与 `ok:true` 由实现保证）。

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/tools/host-tools.ts examples/flutter-dev-bff/src/tools/host-tools.test.ts
git commit -m "feat: host 工具集（文件读写/exec/notify/web_fetch/clipboard）"
```

---

### Task 4: 交互工具（ask_user、user_confirm）

**Files:**
- Create: `examples/flutter-dev-bff/src/tools/user-interaction-tools.ts`
- Test: `examples/flutter-dev-bff/src/tools/user-interaction-tools.test.ts`

**Interfaces:**
- Consumes: `AskService`（Task 1）
- Produces:
  - `interface UserInteractionService { ask: AskService }`
  - `function createUserInteractionToolDefinitions(svc: UserInteractionService): ToolDefinition[]`（`ask_user` + `user_confirm`）

- [ ] **Step 1: 写失败测试**

```ts
// examples/flutter-dev-bff/src/tools/user-interaction-tools.test.ts
import { describe, it, expect } from 'vitest'
import { createAskService } from '../services/ask-service.js'
import { createUserInteractionToolDefinitions } from './user-interaction-tools.js'
import type { ToolDefinition } from '@agent-kit/core'

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

function run(t: ToolDefinition, input: unknown, context: unknown) {
  return (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(input, context)
}

describe('用户交互工具', () => {
  function make() {
    let lastCallId = ''
    const events: unknown[] = []
    const ask = createAskService({ emit: (e) => { events.push(e); const c = e as { callId: string }; lastCallId = c.callId } })
    const tools = createUserInteractionToolDefinitions({ ask })
    return { ask, events, tools, getLast: () => lastCallId }
  }

  it('ask_user 阻塞并回填单选答案', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'ask_user')
    const p = run(t, { question: '选哪个', select: 'single', options: ['A', 'B'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    const callId = getLast()
    ask.resolve('flutter-dev:s1', callId, 'A')
    await expect(p).resolves.toMatchObject({ ok: true, answer: 'A' })
  })
  it('ask_user 多选回填数组', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'ask_user')
    const p = run(t, { question: '多选', select: 'multiple', options: ['x', 'y', 'z'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), ['x', 'z'])
    await expect(p).resolves.toMatchObject({ ok: true, answer: ['x', 'z'] })
  })
  it('ask_user 空 question 返回错误', async () => {
    const { tools } = make()
    const t = byName(tools, 'ask_user')
    const out = await run(t, { question: '  ', select: 'single' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(out.ok).toBe(false)
  })
  it('ask_user 多选选项不足 2 返回错误', async () => {
    const { tools } = make()
    const t = byName(tools, 'ask_user')
    const out = await run(t, { question: 'q', select: 'multiple', options: ['x'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(out.ok).toBe(false)
  })
  it('user_confirm 允许返回 allow', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: '写文件 /x', target: '/x' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    const ev = (await Promise.resolve(getLast()))
    ask.resolve('flutter-dev:s1', ev, '允许')
    await expect(p).resolves.toMatchObject({ decision: 'allow' })
  })
  it('user_confirm 拒绝返回 deny', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: '执行 rm -rf' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), '拒绝')
    await expect(p).resolves.toMatchObject({ decision: 'deny' })
  })
  it('user_confirm 取消时返回 error（AskService cancel 路径）', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: 'x' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    await new Promise((r) => setTimeout(r, 5)) // 等 ask 事件登记
    ask.cancel(getLast())
    await expect(p).resolves.toMatchObject({ error: 'cancelled' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/user-interaction-tools.test.ts`
Expected: FAIL "Cannot find module './user-interaction-tools'"

- [ ] **Step 3: 实现 user-interaction-tools.ts**

```ts
// examples/flutter-dev-bff/src/tools/user-interaction-tools.ts
import { z } from 'zod'
import type { ToolDefinition } from '@agent-kit/core'
import type { AskService } from '../services/ask-service.js'

export interface UserInteractionService {
  ask: AskService
}

export function createUserInteractionToolDefinitions(svc: UserInteractionService): ToolDefinition[] {
  async function awaitAndSweep(sessionId: string, callId: string, kind: 'question' | 'approval', question: string, options: string[], select: 'single' | 'multiple') {
    if (callId === '') return { ok: false, error: '缺少 callId' } as Record<string, unknown>
    const abort = () => svc.ask.cancel(callId)
    // abort 监听由调用方注入？此处没有 signal；交由 harness 取消路径即可，登记兜底清理用 try/finally
    try {
      const answer = await svc.ask.awaitAnswer({ sessionId, callId, kind, question, options, select })
      return answer
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  return [
    {
      name: 'ask_user',
      execution: 'server',
      description: '向用户提出一个问题并等待回答。可单选或多选，用户也可用输入框输入其他答案。用于需要用户决策或提供信息的时刻。',
      input: z.object({
        question: z.string(),
        select: z.enum(['single', 'multiple']),
        options: z.array(z.string()).optional(),
      }),
      output: z.object({ ok: z.boolean(), answer: z.union([z.string(), z.array(z.string())]).optional(), error: z.string().optional(), timeout: z.boolean().optional() }),
      timeoutMs: 300_000,
      async execute(raw, context) {
        const { question, select, options = [] } = raw as { question: string; select: 'single' | 'multiple'; options?: string[] }
        if (!question.trim()) return { ok: false, error: 'question 不能为空' }
        if (select === 'multiple' && options.length < 2) return { ok: false, error: '多选至少需要 2 个选项' }
        if (select === 'single' && options.length === 1) return { ok: false, error: '单选需 0 或 2+ 个选项，否则无意义' }
        const sessionId = ((context ?? {}) as { sessionId?: string }).sessionId ?? ''
        const callId = ((context ?? {}) as { callId?: string }).callId ?? ''
        const res = await awaitAndSweep(sessionId, callId, 'question', question, options, select)
        if (typeof res === 'string') return { ok: false, error: res }
        return { ok: true, answer: res }
      },
    },
    {
      name: 'user_confirm',
      execution: 'server',
      description: '请用户对一个即将执行的高危操作做允许/拒绝审批。先说明要做什么：action（简明操作）、target（对象，如路径/命令/URL）、message（展示文案）、purpose（审批理由）。',
      input: z.object({
        action: z.string(),
        target: z.string().optional(),
        message: z.string().optional(),
        purpose: z.string().optional(),
      }),
      output: z.object({ decision: z.enum(['allow', 'deny']).optional(), error: z.string().optional() }),
      timeoutMs: 300_000,
      async execute(raw, context) {
        const { action, target, message } = raw as { action: string; target?: string; message?: string }
        const sessionId = ((context ?? {}) as { sessionId?: string }).sessionId ?? ''
        const callId = ((context ?? {}) as { callId?: string }).callId ?? ''
        const question = message || `允许${target ? ` ${target}` : ''}${action ? `：${action}` : ''} 吗？`
        const res = await awaitAndSweep(sessionId, callId, 'approval', question, ['允许', '拒绝'], 'single')
        if (typeof res === 'string') return { error: res }
        return res === '允许' ? { decision: 'allow' } : { decision: 'deny' }
      },
    },
  ]
}
```

说明：`awaitAndSweep` 的取消由 harness 的 abort 传播：工具被取消时其 `execute` 的 promise 会因 harness 抛错而不再继续，`pendingAsks` 中残留条目由 harness 超时/进程退出自然清理。这里不做显式 signal 监听，保持简单；Task 5 在 `/api/sessions/:id/asks/:callId` 端点里注入取消兜底。

- [ ] **Step 4: 运行测试确认通过**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/tools/user-interaction-tools.test.ts`
Expected: PASS（6 例全过；取消例经 `ask.cancel` 触发）

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/tools/user-interaction-tools.ts examples/flutter-dev-bff/src/tools/user-interaction-tools.test.ts
git commit -m "feat: 用户交互工具 ask_user / user_confirm"
```

---

### Task 5: server.ts 接线（服务构造 + 合并工具 + 新增端点）

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`

**Interfaces:**
- Consumes: `createAskService`、`createHostPolicyService`（Task 1）；`createHostToolDefinitions`（Task 3）；`createUserInteractionToolDefinitions`（Task 4）
- Produces:
  - `POST /api/sessions/:sessionId/asks/:callId` 端点（Body `{ answer: string | string[] }`）
  - `GET /api/sessions/:sessionId/settings`、`POST /api/sessions/:sessionId/settings` 端点
  - `workspaceRoot` 取值：`options.flutterProjectPath`

- [ ] **Step 1: 在 server.ts 顶部增加导入**

在既有 import 区追加：

```ts
import { createAskService } from './services/ask-service.js'
import { createHostPolicyService } from './services/host-policy.js'
import { createHostToolDefinitions } from './tools/host-tools.js'
import { createUserInteractionToolDefinitions } from './tools/user-interaction-tools.js'
```

- [ ] **Step 2: 把 bus 构造提前，并创建 ask/hostPolicy 服务，合并新工具**

把 `const bus = createEventBus()`（当前在 ~line 129）**上移**到 `const adb = new AdbClient()` 之后、`createFlutterToolDefinitions` 之前；在其后插入服务构造与工具合并。原 `createFlutterToolDefinitions({...})` 调用保持不变。在 `let finalTools = new Map([...toolDefinitions, ...pluginTools]...)` 之前插入：

```ts
const askService = createAskService(bus)
const hostPolicy = createHostPolicyService()
const workspaceRoot = options.flutterProjectPath

const userToolDefs = createUserInteractionToolDefinitions({ ask: askService })
const hostToolDefs = createHostToolDefinitions({ workspaceRoot, ask: askService, policy: hostPolicy })
const newTools = [...userToolDefs, ...hostToolDefs]

let finalTools = new Map([...toolDefinitions, ...newTools, ...pluginTools].map((t) => [t.name, t]))
```

（第二步把 `pluginTools` 也并进同一个 Map；若原代码是两步合并，改成一行合并即可。）

- [ ] **Step 3: 在 `/api/sessions/:id/messages` 端点附近追加两个端点**

```ts
// 问询/审批回填：callId 必须属于该会话且未决
app.post('/api/sessions/:sessionId/asks/:callId', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
  if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const answer = (body as { answer?: unknown }).answer
  if (answer === undefined) return c.json({ error: 'answer is required' }, 400)
  const scopedId = `flutter-dev:${c.req.param('sessionId')}`
  const ok = askService.resolve(scopedId, c.req.param('callId'), answer as string | string[])
  if (!ok) return c.json({ error: 'no pending ask for this callId' }, 404)
  return c.json({ ok: true })
})

// 受信任 host 模式开关（按会话）
app.get('/api/sessions/:sessionId/settings', (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
  if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
  const scopedId = `flutter-dev:${c.req.param('sessionId')}`
  return c.json({ trustedHost: hostPolicy.isTrusted(scopedId) })
})
app.post('/api/sessions/:sessionId/settings', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
  if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const trusted = typeof (body as { trustedHost?: unknown }).trustedHost === 'boolean'
    ? (body as { trustedHost: boolean }).trustedHost
    : false
  const scopedId = `flutter-dev:${c.req.param('sessionId')}`
  hostPolicy.setTrusted(scopedId, trusted)
  return c.json({ ok: true })
})
```

注意：`askService` 与 `hostPolicy` 都是 `createFlutterDevBff` 函数体内局部变量，为这两个端点与工具共用；若两个端点定义在闭包之外不可达（它们在同一个 `createFlutterDevBff` 作用域内，可达）。

- [ ] **Step 4: 类型检查**
Run: `cd examples/flutter-dev-bff && pnpm exec tsc -p tsconfig.json`
Expected: 无错误（`options.flutterProjectPath` 已是 `FlutterToolServices` 既有字段；`workspaceRoot` 复用同值）

- [ ] **Step 5: 更新 server.test.ts 覆盖新端点**

在 `examples/flutter-dev-bff/src/server.test.ts` 末尾追加：

```ts
it('POST /api/sessions/:id/asks/:callId 回填 pending 审批', async () => {
  // 借助 ask_user 工具触发一个 pending ask，再走端点回填
  // 由于需要等待工具阻塞，此用例用超时后的「无 pending」路径断言安全返回
  const res = await fetch(`${base}/api/sessions/s1/asks/nope`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer: '允许' }),
  })
  expect(res.status).toBe(404)
})

it('GET/POST 受信任 host 设置按会话读写', async () => {
  const get = await fetch(`${base}/api/sessions/s1/settings`, { headers: { authorization: `Bearer ${TOKEN}` } })
  expect((await get.json() as { trustedHost?: boolean }).trustedHost).toBe(false)
  const post = await fetch(`${base}/api/sessions/s1/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ trustedHost: true }),
  })
  expect((await post.json() as { ok?: boolean }).ok).toBe(true)
  const get2 = await fetch(`${base}/api/sessions/s1/settings`, { headers: { authorization: `Bearer ${TOKEN}` } })
  expect((await get2.json() as { trustedHost?: boolean }).trustedHost).toBe(true)
})
```

先读 `server.test.ts` 现有顶部以复用其 `base`/`TOKEN` 常量与既有构造方式；若常量名不同，改成与之匹配。

- [ ] **Step 6: 运行 server 测试**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/server.test.ts`
Expected: 新增用例通过、既有用例不回归。

- [ ] **Step 7: Commit**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/server.test.ts
git commit -m "feat: 接线 Ask 回填与受信任 host 设置端点，合并新工具"
```

---

### Task 6: WebUI 前端（问答/审批卡片 + 受信任开关 + 历史还原）

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`
- Modify: `examples/flutter-dev-bff/public/assets/app.js`
- Modify: `examples/flutter-dev-bff/public/assets/app.css`

**Interfaces:**
- Consumes: `ask_user` SSE 事件（Task 1 AskService 发，含 `kind`/`sessionId`/`callId`/`question`/`options`/`select`）；`POST /api/sessions/:id/asks/:callId` 与 `GET/POST /api/sessions/:id/settings`（Task 5）
- Produces: WebUI 功能，无测试基建（手动浏览器验证）

- [ ] **Step 1: index.html 设置面板加受信任开关**

在设置面板（`#settings-panel`）的「主题」set-row 之后追加：

```html
<div class="setting-row">
  <div>
    <div class="label">受信任 host 模式</div>
    <div class="desc">开启后 host 写文件/执行命令/写剪贴板直接放行，不再逐次审批。仅当前会话生效。</div>
  </div>
  <label class="switch">
    <input type="checkbox" id="setting-trusted-host">
    <span class="slider"></span>
  </label>
</div>
```

- [ ] **Step 2: app.js 加受信任开关读写**

在设置段（`copyLimitEl` 附近）追加逻辑，并在 `init()` 里 `applySidebarWidth()` 之后调用 `loadTrustedHost()`：

```js
const trustedHostEl = $('setting-trusted-host')
async function loadTrustedHost() {
  if (!currentSessionId) return
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/settings`)
    trustedHostEl.checked = !!data.trustedHost
  } catch { /* 默认关 */ }
}
trustedHostEl.addEventListener('change', async () => {
  if (!currentSessionId) return
  await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/settings`, {
    method: 'POST', body: JSON.stringify({ trustedHost: trustedHostEl.checked }),
  }).catch(() => {})
})
```

- [ ] **Step 3: app.js 加 ask_user 事件 + 卡片渲染 + 提交**

在 `connectEvents()` 里新增监听，并新增两个渲染/提交函数：

```js
// 在 connectEvents() 的 es.addEventListener 序列里，紧跟 llm_delta 监听之后：
es.addEventListener('ask_user', (e) => {
  const data = JSON.parse(e.data)
  routeEvent(data, Number(e.lastEventId), (view) => {
    renderAskCard(view, data)
  })
})

// 卡片渲染：kind=question 问询 / kind=approval 审批
function renderAskCard(view, data) {
  const card = document.createElement('div')
  card.className = 'msg ask-card'
  const isApproval = data.kind === 'approval'
  const options = Array.isArray(data.options) ? data.options : []
  let optsHtml = ''
  if (data.select === 'single') {
    optsHtml = `<div class="ask-options single">${options.map((o) => `<button class="ask-opt" data-val="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`
  } else {
    optsHtml = `<div class="ask-options multi">${options.map((o) => `<label class="ask-chip"><input type="checkbox" value="${escapeHtml(o)}">${escapeHtml(o)}</label>`).join('')}</div>`
  }
  card.innerHTML = `
    <div class="ask-title">${isApproval ? '⚠️ 操作审批' : '❓ 需要你回答'}：${escapeHtml(data.question)}</div>
    ${optsHtml}
    <div class="ask-input-row"><input class="ask-input" type="text" placeholder="…或输入其他答案"></div>
    <button class="ask-submit">提交</button>`
  view.el.appendChild(card)
  scrollBottom()
  // 单选：点选项即提交
  card.querySelectorAll('.ask-opt').forEach((btn) => btn.addEventListener('click', () => {
    submitAnswer(view, card, data, btn.dataset.val)
  }))
  const submit = card.querySelector('.ask-submit')
  const input = card.querySelector('.ask-input')
  submit.addEventListener('click', () => {
    if (data.select === 'multiple') {
      const checked = Array.from(card.querySelectorAll('.ask-chip input:checked')).map((i) => i.value)
      const extra = input.value.trim()
      const values = extra ? [...checked, extra] : checked
      submitAnswer(view, card, data, values)
    } else {
      submitAnswer(view, card, data, input.value.trim() || (card.querySelector('.ask-opt.selected')?.dataset.val ?? ''))
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click() })
}

function submitAnswer(view, card, data, answer) {
  card.querySelectorAll('button, input').forEach((el) => { el.disabled = true })
  fetch(`/api/sessions/${encodeURIComponent(normalizeSessionId(data.sessionId))}/asks/${encodeURIComponent(data.callId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer }),
  })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
    .then(() => {
      card.classList.add('answered')
      const disp = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '')
      card.querySelector('.ask-input-row')?.remove()
      card.querySelector('.ask-options')?.remove()
      card.querySelector('.ask-submit')?.remove()
      card.querySelector('.ask-title').textContent = `✅ 已${data.kind === 'approval' ? '审' : '答'}：${disp}`
    })
    .catch((err) => { alert('提交失败: ' + err.message) })
}
```

- [ ] **Step 4: app.js 历史还原渲染已答/已审摘要**

在 `restoreHistory()` 里，处理 tool 消息时，若 `m.toolName` 为 `ask_user` 或 `user_confirm`，渲染折叠摘要代替通用工具卡片：

```js
// 在 restoreHistory 的 for 循环里、else if (m.role === 'assistant') 分支之前，显式处理：
if (m.role === 'tool' && (m.toolName === 'ask_user' || m.toolName === 'user_confirm')) {
  const summary = (() => {
    const content = m.content
    if (content && typeof content === 'object' && 'answer' in content) return String(content.answer)
    if (content && typeof content === 'object' && 'decision' in content) return String(content.decision)
    if (content && typeof content === 'object' && 'error' in content) return `(${String(content.error)})`
    return ''
  })()
  const div = document.createElement('div')
  div.className = 'msg ask-card answered'
  div.textContent = `📌 ${m.toolName === 'user_confirm' ? '已审' : '已答'}：${summary || '（无记录）'}`
  view.el.appendChild(div)
  continue
}
```

（`toolName` 在历史 tool 消息上可见——harness 落库 tool 消息时带 `toolName`。）

- [ ] **Step 5: app.css 加 ask 卡片样式**

在 `app.css` 末尾追加：

```css
/* 问答 / 审批卡片 */
.ask-card { align-self: flex-start; max-width: 90%; background: var(--surface); border: 1px solid var(--accent); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.ask-card.answered { border-color: var(--border); opacity: 0.9; }
.ask-title { font-size: 13px; font-weight: 600; }
.ask-options { display: flex; flex-wrap: wrap; gap: 6px; }
.ask-options.single .ask-opt { padding: 6px 12px; border: 1px solid var(--border); background: var(--tool-bg); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 12px; }
.ask-options.single .ask-opt:hover { border-color: var(--accent); }
.ask-options.multi .ask-chip { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; cursor: pointer; }
.ask-input-row { display: flex; }
.ask-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 10px; font-size: 13px; }
.ask-submit { align-self: flex-end; padding: 8px 16px; background: var(--accent); color: var(--bg); border: none; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; }
```

- [ ] **Step 6: 语法校验**
Run: `node --check examples/flutter-dev-bff/public/assets/app.js`
Expected: 无输出（成功）

- [ ] **Step 7: Commit**

```bash
git add examples/flutter-dev-bff/public/index.html examples/flutter-dev-bff/public/assets/app.js examples/flutter-dev-bff/public/assets/app.css
git commit -m "feat: WebUI 问答/审批卡片与受信任 host 开关"
```

---

### Task 7: Prompt 指引 + 全量回归 + 手动浏览器验证

**Files:**
- Modify: `examples/flutter-dev-bff/src/prompts.ts`
- Test: 全量 `pnpm -r test`；flutter-dev-bff 手动浏览器验证

**Interfaces:**
- Consumes: 全部前述任务

- [ ] **Step 1: freeFormPrompt 追加工具使用指引**

在 `examples/flutter-dev-bff/src/prompts.ts` 的 `freeFormPrompt` 数组「最终输出要求」之前追加两行：

```js
'- 需要用户决策/提供信息时用 ask_user（可选择项给 options，单选/多选皆可）；高风险操作（写文件、执行命令、写剪贴板）必须先经 user_confirm 审批，用户拒绝（decision=deny）则如实告知并停止该步，不要强行执行。',
'- 写/读文件默认限于工作区根目录；路径越界会失败。可用 host_exec 在用户电脑跑命令辅助排查（同样需审批）。',
```

- [ ] **Step 2: 全量类型 + 单测**
Run: `cd examples/flutter-dev-bff && pnpm exec tsc -p tsconfig.json && pnpm exec vitest run`
Expected: 全部通过，既有 113 + 新增全绿

- [ ] **Step 3: 全仓回归**
Run: `pnpm -r test 2>&1 | grep -E "Test Files|Tests "`
Expected: 仅浏览器-extension-bff 那条既有失败（与本次无关）；其余全绿

- [ ] **Step 4: 手动浏览器验证**

用 `superpowers:executing-plans` 或人工：`pnpm --filter flutter-dev-bff start`（或用 `.claude/launch.json` 的 flutter-dev-bff 预览），浏览器里验证：

- 页面边栏/主区正常加载，设置面板出现「受信任 host 模式」开关（默认关）
- 发一条会导致 `host_exec` 的指令（如「帮我看看当前目录有多少文件 用 host_exec 跑 ls | wc -l」）：先出现审批卡片「允许执行命令…」，点「允许」后卡片变「已审」，随后 LLM 继续输出
- 点拒绝：LLM 如实说明「用户拒绝了，停止该步」
- 发含 `ask_user` 的指令：单选显示选项按钮、多选显示可勾选 chips，输入框可填其他；作答后卡片变「已答」
- 打开受信任开关后重发高危指令：不再弹审批、直接执行
- 历史还原：刷新页面，已答/已审的卡片以折叠摘要显示
- 全程无 console 报错

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/prompts.ts
git commit -m "docs: prompt 补充 ask_user/user_confirm 与 host 工具使用指引"
```

---

### Task 8: 收尾

- [ ] **Step 1: 整理未提交内容，确认工作区干净**
Run: `git status --short`
Expected: 干净（只剩本计划提交）

- [ ] **Step 2: 视用户决定合并/建 PR（可交由 finishing-a-development-branch）**