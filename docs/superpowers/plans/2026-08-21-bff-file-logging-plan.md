# BFF 按日轮转文件日志（winston）+ WebUI 底部版权 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 flutter-dev-bff 加按日轮转的写文件日志（默认开、目录/格式/保留天数可配，默认 verbose 含完整 LLM 输入输出），并在 WebUI 底部加 `copyright © 2026 xuewen.jia`。

**Architecture:** 用 winston + winston-daily-rotate-file 作为 core 日志器（`createConsoleAuditLogger` / `createLlmVerboseLogger`）的 file sink；core 不改。`LOG_FORMAT` 决定把谁喂进文件与用哪种行序列化。纯逻辑（配置解析、JSON 行序列化）放独立模块便于单测；winston 接线薄封装。

**Tech Stack:** winston、winston-daily-rotate-file、TypeScript strict、vitest、原生 HTML/CSS。

## Global Constraints

- `@agent-kit/core` **不改**——只注入 sink，沿用既有 `createConsoleAuditLogger`/`createLlmVerboseLogger` 的 `sink` 接口
- 日志**绝不含 API Key**（core verbose/audit 已保证；JSON 序列化也不引入）
- 默认 `LOG_FORMAT=verbose` 会把完整 Prompt/会话历史写盘——与代码安全红线相反，但用户要量化一天体量，属知情选择
- `LOG_KEEP_DAYS=0` = 永久保留，不传 `maxFiles` 给轮转 transport
- 文件日志的初始化只发生在 `isMainModule` 主入口块（`!process.env.VITEST`）；`createFlutterDevBff` 本身不初始化文件，仅通过注入的 `audit`/`llmTrace` 选项接收
- 新增依赖到 `examples/flutter-dev-bff`（`pnpm --filter flutter-dev-bff`）
- 实现时**新开分支**（worktree），不直接在 main 上写代码

---

### Task 1: 日志依赖 + 纯逻辑（配置解析 + JSON 行序列化）

**Files:**
- Modify: `examples/flutter-dev-bff/package.json`（新增依赖）
- Create: `examples/flutter-dev-bff/src/services/log-format.ts`
- Test: `examples/flutter-dev-bff/src/services/log-format.test.ts`

**Interfaces:**
- Produces:
  - `type LogFormat = 'verbose' | 'json' | 'audit'`
  - `interface FileLogConfig { enabled: boolean; dir: string; format: LogFormat; keepDays: number }`
  - `function parseFileLogConfig(env: Record<string, string | undefined>, fallbackDir: string): FileLogConfig`
  - `function auditToJsonLine(event: { requestId?: string; model?: string; toolName?: string; httpStatus?: number; durationMs?: number; errorCode?: string }): string`
  - `function llmToJsonLine(event: { phase: string; requestId: string; durationMs: number; body?: unknown; responseBody?: unknown; error?: unknown }): string`

- [ ] **Step 1: 加依赖**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit/.claude/worktrees/feature+file-logging/examples/flutter-dev-bff
pnpm --filter flutter-dev-bff add winston winston-daily-rotate-file
```
（若 `winston-daily-rotate-file` 无内置类型导致 tsc 报错，再补 `pnpm --filter flutter-dev-bff add -D @types/winston-daily-rotate-file`。）

- [ ] **Step 2: 写失败的纯逻辑测试**

```ts
// examples/flutter-dev-bff/src/services/log-format.test.ts
import { describe, it, expect } from 'vitest'
import { parseFileLogConfig, auditToJsonLine, llmToJsonLine } from './log-format.js'

describe('parseFileLogConfig', () => {
  it('默认值：开启、verbose、fallback 目录、7 天', () => {
    const c = parseFileLogConfig({}, '/data')
    expect(c).toMatchObject({ enabled: true, dir: '/data/logs', format: 'verbose', keepDays: 7 })
  })
  it('LOG_TO_FILE=0 关闭', () => {
    expect(parseFileLogConfig({ LOG_TO_FILE: '0' }, '/d').enabled).toBe(false)
  })
  it('LOG_DIR/LOG_FORMAT/LOG_KEEP_DAYS 生效', () => {
    const c = parseFileLogConfig({ LOG_DIR: '/x', LOG_FORMAT: 'json', LOG_KEEP_DAYS: '0' }, '/d')
    expect(c).toMatchObject({ dir: '/x', format: 'json', keepDays: 0 })
  })
  it('非法格式回退 verbose', () => {
    expect(parseFileLogConfig({ LOG_FORMAT: 'nope' }, '/d').format).toBe('verbose')
  })
})

describe('auditToJsonLine', () => {
  it('输出单行 JSON，含关键字段', () => {
    const line = auditToJsonLine({ requestId: 'r1', model: 'm', toolName: 't', durationMs: 5, errorCode: 'E' })
    const o = JSON.parse(line)
    expect(o).toMatchObject({ kind: 'audit', requestId: 'r1', model: 'm', tool: 't', ms: 5, error: 'E' })
  })
})

describe('llmToJsonLine', () => {
  it('request 相位带 messages 与 tools 数', () => {
    const line = llmToJsonLine({ phase: 'request', requestId: 'r1', durationMs: 0, body: { model: 'm', messages: [{ role: 'user' }], tools: [{}] } })
    const o = JSON.parse(line)
    expect(o).toMatchObject({ kind: 'llm', phase: 'request', requestId: 'r1', model: 'm', tools: 1 })
    expect(Array.isArray(o.messages)).toBe(true)
  })
  it('response 相位带 responseBody', () => {
    const o = JSON.parse(llmToJsonLine({ phase: 'response', requestId: 'r1', durationMs: 3, responseBody: { choices: [] } }))
    expect(o.responseBody).toEqual({ choices: [] })
  })
})
```

- [ ] **Step 3: 运行测试确认失败**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/log-format.test.ts`
Expected: FAIL "Cannot find module './log-format'"

- [ ] **Step 4: 实现 log-format.ts**

```ts
// examples/flutter-dev-bff/src/services/log-format.ts
import { join } from 'node:path'

export type LogFormat = 'verbose' | 'json' | 'audit'

export interface FileLogConfig {
  enabled: boolean
  dir: string
  format: LogFormat
  /** 保留文件天数；0 = 永久保留。仅启动读取。 */
  keepDays: number
}

const FORMATS: LogFormat[] = ['verbose', 'json', 'audit']

export function parseFileLogConfig(env: Record<string, string | undefined>, fallbackDir: string): FileLogConfig {
  const format = (env.LOG_FORMAT ?? 'verbose') as LogFormat
  return {
    enabled: (env.LOG_TO_FILE ?? '1') !== '0',
    dir: env.LOG_DIR || join(fallbackDir, 'logs'),
    format: FORMATS.includes(format) ? format : 'verbose',
    keepDays: Number(env.LOG_KEEP_DAYS ?? '7') || 0,
  }
}

type AuditLike = { requestId?: string; model?: string; toolName?: string; httpStatus?: number; durationMs?: number; errorCode?: string }

export function auditToJsonLine(event: AuditLike): string {
  const o: Record<string, unknown> = { kind: 'audit', requestId: event.requestId }
  if (event.model) o.model = event.model
  if (event.toolName) o.tool = event.toolName
  if (event.httpStatus !== undefined) o.http = event.httpStatus
  if (event.durationMs) o.ms = event.durationMs
  if (event.errorCode) o.error = event.errorCode
  return JSON.stringify(o)
}

type LlmLike = { phase: 'request' | 'response' | 'error'; requestId: string; durationMs: number; body?: unknown; responseBody?: unknown; error?: unknown }

export function llmToJsonLine(event: LlmLike): string {
  const o: Record<string, unknown> = { kind: 'llm', phase: event.phase, requestId: event.requestId, durationMs: event.durationMs }
  if (event.phase === 'request') {
    const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
    o.model = body.model
    o.tools = Array.isArray(body.tools) ? body.tools.length : 0
    o.messages = body.messages // 含完整 prompt/会话历史（与 verbose 同级的敏感信息）
  } else if (event.phase === 'response') {
    o.responseBody = event.responseBody
  } else {
    o.error = event.error
  }
  return JSON.stringify(o)
}
```

- [ ] **Step 5: 运行测试确认通过**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/log-format.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add examples/flutter-dev-bff/package.json examples/flutter-dev-bff/pnpm-lock.yaml examples/flutter-dev-bff/src/services/log-format.ts examples/flutter-dev-bff/src/services/log-format.test.ts
git commit -m "feat: 文件日志配置解析与 JSON 行序列化"
```

---

### Task 2: winston 按日轮转文件写入器

**Files:**
- Create: `examples/flutter-dev-bff/src/services/file-logger.ts`
- Test: `examples/flutter-dev-bff/src/services/file-logger.test.ts`

**Interfaces:**
- Consumes: `createFileLogger` 用 `FileLogConfig`（Task 1）
- Produces:
  - `interface FileLoggerHandle { sink: { log(message: string): void }; close(): Promise<void> }`
  - `function createFileLogger(config: FileLogConfig): FileLoggerHandle`

- [ ] **Step 1: 写失败测试**

```ts
// examples/flutter-dev-bff/src/services/file-logger.test.ts
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createFileLogger } from './file-logger.js'

describe('createFileLogger', () => {
  it('写入后产生当日 bff-YYYY-MM-DD.log 且包含内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ak-fl-'))
    const h = createFileLogger({ enabled: true, dir, format: 'verbose', keepDays: 7 })
    h.sink.log('第一行 hello')
    h.sink.log('第二行 world')
    await new Promise((r) => setTimeout(r, 300)) // 等 winston flush
    const files = readdirSync(dir).filter((f) => /^bff-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(1)
    const content = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    expect(content).toContain('第一行 hello')
    expect(content).toContain('第二行 world')
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/file-logger.test.ts`
Expected: FAIL "Cannot find module './file-logger'"

- [ ] **Step 3: 实现 file-logger.ts**

```ts
// examples/flutter-dev-bff/src/services/file-logger.ts
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FileLogConfig } from './log-format.js'

export interface FileLoggerHandle {
  sink: { log(message: string): void }
  close(): Promise<void>
}

/** 按日轮转写入器：append 到 bff-YYYY-MM-DD.log，跨天自动换文件，按 keepDays 清理。 */
export function createFileLogger(config: FileLogConfig): FileLoggerHandle {
  // 目录缺失直接建；失败抛给调用方降级（不阻断 BFF 启动）
  mkdirSync(config.dir, { recursive: true })
  const transport = new DailyRotateFile({
    filename: `${join(config.dir, 'bff')}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    // keepDays=0 时不传 maxFiles，即永久保留
    ...(config.keepDays > 0 ? { maxFiles: String(config.keepDays) } : {}),
    format: winston.format.printf((info) => (typeof info.message === 'string' ? info.message : '')),
  })
  const logger = winston.createLogger({ level: 'info', transports: [transport], exitOnError: false })
  return {
    sink: { log(message: string) { logger.log({ level: 'info', message }) } },
    close() {
      return new Promise<void>((resolve) => {
        transport.close(() => resolve())
      })
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run src/services/file-logger.test.ts`
Expected: PASS（1 test）。若 300ms 内未 flush 偶发失败，把延时调到 500ms。

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/services/file-logger.ts examples/flutter-dev-bff/src/services/file-logger.test.ts
git commit -m "feat: winston 按日轮转文件日志写入器"
```

---

### Task 3: server.ts 接线 + .env 模板注释

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`

**Interfaces:**
- Consumes: `parseFileLogConfig`、`auditToJsonLine`、`llmToJsonLine`（Task 1）、`createFileLogger`、`FileLoggerHandle`（Task 2）；core 的 `createConsoleAuditLogger`、`createLlmVerboseLogger`、类型 `AuditLogger`、`LlmTraceEvent`
- Produces: 主入口块读 env → 组装 file audit/llm handler → 注入 `createFlutterDevBff` 的 `audit`/`llmTrace`；`ensureEnvTemplate` 追加日志配置注释

- [ ] **Step 1: 顶部 import 追加核心类型**

在 `server.ts` 的 `@agent-kit/core` 类型导入处补 `AuditLogger`（若尚未导入）。同时新增 import：

```ts
import { parseFileLogConfig, auditToJsonLine, llmToJsonLine } from './services/log-format.js'
import { createFileLogger, type FileLoggerHandle } from './services/file-logger.js'
```

- [ ] **Step 2: 主入口块组装文件日志并注入**

把当前（约 line 624-626）：

```ts
const logLevel = process.env.LOG_LEVEL ?? 'info'
const llmTrace = logLevel === 'verbose' ? createLlmVerboseLogger({ prefix: '[flutter-bff:llm]' }) : undefined
if (llmTrace) console.log('[flutter-bff] LOG_LEVEL=verbose')
```

替换为：

```ts
const logLevel = process.env.LOG_LEVEL ?? 'info'
const consoleLlm = logLevel === 'verbose' ? createLlmVerboseLogger({ prefix: '[flutter-bff:llm]' }) : undefined
if (consoleLlm) console.log('[flutter-bff] LOG_LEVEL=verbose')

// ── 按日轮转文件日志（常驻，默认开启）──
const fileLogConfig = parseFileLogConfig(process.env, getProgramDir())
let fileLogger: FileLoggerHandle | undefined
let fileAudit: AuditLogger | undefined
let fileLlm: ((event: LlmTraceEvent) => void) | undefined
if (fileLogConfig.enabled) {
  try {
    fileLogger = createFileLogger(fileLogConfig)
    const sink = fileLogger!.sink
    if (fileLogConfig.format === 'json') {
      fileAudit = { log: (e) => { const l = auditToJsonLine(e); if (l) sink.log(l) } }
      fileLlm = (e) => { const l = llmToJsonLine(e); if (l) sink.log(l) }
    } else if (fileLogConfig.format === 'verbose') {
      fileAudit = createConsoleAuditLogger({ prefix: '[file]', sink })
      fileLlm = createLlmVerboseLogger({ prefix: '[file:llm]', sink })
    } else {
      fileAudit = createConsoleAuditLogger({ prefix: '[file]', sink })
    }
    console.log(`[flutter-bff] 文件日志已开启：${join(fileLogConfig.dir, 'bff-*.log')} format=${fileLogConfig.format} keep=${fileLogConfig.keepDays}天`)
  } catch (error) {
    console.error(`[flutter-bff] 文件日志初始化失败，已降级为 console：${error instanceof Error ? error.message : String(error)}`)
    fileLogger = undefined
  }
}

// 组合审计：console + 文件
const baseAudit = createConsoleAuditLogger({ prefix: '[flutter-bff]' })
const auditLogger: AuditLogger | undefined = fileAudit
  ? { log: (e) => { baseAudit.log(e); fileAudit.log(e) } }
  : baseAudit
// 组合 LLM trace：console(verbose 时) + 文件(格式非 audit 时)
const llmTraceComposite: ((event: LlmTraceEvent) => void) | undefined =
  consoleLlm || fileLlm
    ? (e) => { consoleLlm?.(e); fileLlm?.(e) }
    : undefined
```

在随后的 `createFlutterDevBff({...})` 调用里补上传参（在既有 `...(options.llmTrace ? ...` 位置上方，按需传 `audit` 与 `llmTrace`）：

```ts
...(llmTraceComposite ? { llmTrace: llmTraceComposite } : {}),
...(auditLogger ? { audit: auditLogger } : {}),
```

（`getProgramDir`、`join`、`LlmTraceEvent` 已在文件中使用/导入。）

- [ ] **Step 3: ensureEnvTemplate 追加日志配置注释**

在模板数组 `'# LOG_LEVEL=verbose',` 之后插入：

```ts
'',
'# ── 文件日志（按日轮转，默认开启）──',
'# 总开关：1=开启写日志文件；0=关闭',
'# LOG_TO_FILE=1',
'# 日志目录（默认 BFF 数据目录/logs）',
'# LOG_DIR=',
'# LOG_FORMAT 支持的 3 种：',
'#   verbose —— 多行人类可读，含完整 LLM 输入输出（Prompt、会话历史、工具调用、模型原文），体量最大、不含 API Key',
'#   json    —— 每条事件一行 JSON，便于脚本/工具解析',
'#   audit   —— 仅非敏感摘要（requestId、模型、工具、耗时、HTTP 状态、错误码），不含 Prompt/业务内容',
'# LOG_FORMAT=verbose',
'# 保留文件天数，0=永久保留；仅启动时读取，改动需重启',
'# LOG_KEEP_DAYS=7',
```

- [ ] **Step 4: 类型检查**
Run: `cd examples/flutter-dev-bff && pnpm exec tsc -p tsconfig.json`
Expected: 无错误（若 `AuditLogger` 未从 core 导出，改为从 `@agent-kit/core` 追加到既有类型导入；`AuditEvent` 不必直接导入，fanout 用结构类型即可）

- [ ] **Step 5: Commit**

```bash
git add examples/flutter-dev-bff/src/server.ts
git commit -m "feat: 接线按日轮转文件日志（audit/llm 双管线）+ .env 模板注释"
```

---

### Task 4: WebUI 底部版权

**Files:**
- Modify: `examples/flutter-dev-bff/public/index.html`
- Modify: `examples/flutter-dev-bff/public/assets/app.css`

**Interfaces:**
- Produces: 主区底部 `.footer-copy` 文案 `copyright © 2026 xuewen.jia`

- [ ] **Step 1: index.html 加 footer**

在 `#input-bar` 结束 `</div>` 之后、`<main>` 内追加：

```html
    <div class="footer-copy">copyright © 2026 xuewen.jia</div>
```

- [ ] **Step 2: app.css 加样式**

在 `app.css` 末尾追加：

```css
/* 底部版权 */
.footer-copy { text-align: center; font-size: 11px; color: var(--text2); padding: 6px 0; flex-shrink: 0; }
```

- [ ] **Step 3: 语法/静态自检**
Run: `cd examples/flutter-dev-bff && node --check public/assets/app.js`
Expected: 无输出（成功）。footer 为静态 HTML/CSS，以手动浏览器验证收尾。

- [ ] **Step 4: Commit**

```bash
git add examples/flutter-dev-bff/public/index.html examples/flutter-dev-bff/public/assets/app.css
git commit -m "feat: WebUI 底部版权 copyright © 2026 xuewen.jia"
```

---

### Task 5: 全量回归 + 手动验证

**Files:**
- Test: 全部包 + 手动浏览器

**Interfaces:**
- Consumes: 全部前述任务

- [ ] **Step 1: flutter-dev-bff 全量测试**
Run: `cd examples/flutter-dev-bff && pnpm exec vitest run`
Expected: 全部通过（既有 + 新增 log 测试）

- [ ] **Step 2: 全仓测试**
Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm -r test 2>&1 | grep -E "Test Files|Tests "`
Expected: 仅 browser-extension-bff 那条既有失败；其余全绿

- [ ] **Step 3: 手动浏览器验证**
Run: 用新分支代码起服务（`.claude/launch.json` 或 `pnpm --filter flutter-dev-bff start`），验证：
- 默认（不加 env）启动：`<BFF 数据目录>/logs/bff-YYYY-MM-DD.log` 生成，发一条指令后文件含审计摘要行；若 `LOG_LEVEL=verbose` 或 `LOG_FORMAT=verbose` 还含完整 LLM 载荷（含 prompt）
- 设置面板 **工作区根目录**、主题等原有功能不回归
- 底部出现「copyright © 2026 xuewen.jia」，亮/暗主题下颜色正常
- 设 `LOG_FORMAT=json` 重启后，文件里每行是合法 JSON
- 设 `LOG_FORMAT=audit` 重启后，文件里只有摘要、无 prompt
- 设 `LOG_TO_FILE=0` 重启后，不产生日志文件
- `LOG_KEEP_DAYS=0` 时日志目录不清旧文件（无 `maxFiles` 清理）

- [ ] **Step 4: Commit**
（一般无代码改动；若有验证期顺手的小修，单独自成一个 commit 并注明）