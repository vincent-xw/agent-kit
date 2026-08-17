import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/**
 * 获取程序所在目录（配置文件与数据库的落地位置）。
 *
 * pkg 打包后代码跑在只读虚拟 FS 里（POSIX 是 /snapshot/...，Windows 是 C:\snapshot\...），
 * 所以不能用 __filename 的目录，必须用 exe 自身所在目录。
 */
function getProgramDir(): string {
  if ((process as { pkg?: unknown }).pkg !== undefined) {
    return dirname(process.execPath)
  }
  if (typeof __filename !== 'undefined') {
    return dirname(__filename)
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url))
    }
  } catch {
    // import.meta 不可用时 fallback
  }
  return dirname(process.execPath)
}

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import { createConsoleAuditLogger, createContextManager, createLlmVerboseLogger, createPromptRegistry } from '@agent-kit/core'
import type { AuditLogger, LlmSecret, LlmTraceEvent } from '@agent-kit/core'
import { WebSocketServer } from 'ws'

import {
  browserAutomationPrompt,
  browserToolDefinitions,
  candidateAssessmentPrompt,
  candidateAssessmentProtocol,
  freeFormPrompt,
  planningPrompt,
  planningProtocol,
} from './browser-tools.js'
import { createEventBus } from './event-bus.js'
import type { EventBus } from './event-bus.js'
import { createWsExecutor } from './ws-executor.js'
import type { WsExecutor } from './ws-executor.js'

/** 装配浏览器扩展专属 BFF：SQLite 密钥库 + Bearer 鉴权 + harness HTTP 边界。 */
export function createBrowserExtensionBff(options: {
  masterKey: string
  apiToken: string
  databasePath?: string
  /** 模型配置。由 BFF 进程环境提供，扩展侧永远看不到这三个字段。 */
  llm?: LlmSecret
  /** 审计日志。省略时使用控制台实现。传 undefined 之外的值可替换或静音。 */
  audit?: AuditLogger
  /** LLM 调用级追踪。开启 verbose 时注入，打印完整输入输出供排障。 */
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
}) {
  // 主密钥只存在于 BFF 进程环境，绝不写入 SQLite，也绝不暴露给浏览器扩展。
  const database = new DatabaseSync(options.databasePath ?? 'agent-kit.sqlite')
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[bff]' })
  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'planning', version: '1', prompt: planningPrompt, protocol: planningProtocol })
  prompts.register({ name: 'browser-automation', version: '1', prompt: browserAutomationPrompt })
  prompts.register({
    name: 'candidate-assessment',
    version: '1',
    prompt: candidateAssessmentPrompt,
    protocol: candidateAssessmentProtocol,
  })

  // 事件总线：工具事件 → SSE 推送
  const eventBus = createEventBus()

  // 上下文管理器：滑动窗口裁剪（200 条消息）
  const contextManager = createContextManager({ maxMessages: 200 })

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    context: contextManager,
    ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of browserToolDefinitions) runtime.tools.register(tool)

  // WebSocket 执行器
  const wsExecutor = createWsExecutor({
    authenticate: async (req) => {
      const token = req.url?.match(/[?&]token=([^&]+)/)?.[1] ?? ''
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    onConnectionChange: (online) => {
      eventBus.emit({ type: 'executor_status', data: { online } })
    },
  })

  // 标准 BFF 路由（continue、tool-results）
  const app = createAgentBff({
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
    audit,
  })

  // 覆盖 run 路由：加入工具执行循环
  app.post('/v1/agent/sessions/:sessionId/run', async (c) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      const identity = await authenticate(c.req.raw, options.apiToken)
      if (!identity) {
        audit?.log({ requestId, durationMs: Date.now() - startedAt, errorCode: 'UNAUTHORIZED' })
        return c.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await c.req.json<{ input?: unknown; context?: unknown; promptName?: unknown; skipTools?: unknown; stepMode?: unknown }>()
      if (typeof body.input !== 'string' || !body.input.trim() || !body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        return c.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }

      const scopedSessionId = `${identity.subject}:${c.req.param('sessionId')}`
      // 第一步：调用 harness.run()
      let result = await runtime.harness.run({
        sessionId: scopedSessionId,
        input: body.input,
        context: body.context as Record<string, unknown>,
        ...(body.promptName ? { promptName: body.promptName as string } : {}),
        ...(body.skipTools === true ? { skipTools: true } : {}),
        stepMode: true,
      })

      // 工具执行循环：处理 pending_tool_calls → WS 执行 → resume → 继续
      let stepCount = 0
      while (result.type !== 'final') {
        if (result.type === 'pending_tool_calls') {
          for (const call of result.calls) {
            stepCount++
            eventBus.emit({ type: 'tool_start', data: { callId: call.callId, toolName: call.toolName, input: call.input, sessionId: scopedSessionId } })
            eventBus.emit({ type: 'step', data: { index: stepCount, total: 0 } })

            let output: unknown
            try {
              output = await wsExecutor.executeTool({ callId: call.callId, toolName: call.toolName, input: call.input })
            } catch (error) {
              output = { ok: false, code: 'EXECUTOR_ERROR', message: error instanceof Error ? error.message : '执行器错误' }
            }
            const durationMs = Date.now() - startedAt
            eventBus.emit({ type: 'tool_end', data: { callId: call.callId, toolName: call.toolName, ok: true, outputPreview: output, durationMs } })

            result = await runtime.harness.resume({ sessionId: scopedSessionId, callId: call.callId, output })
          }
        } else if (result.type === 'step_done') {
          result = await runtime.harness.continue({ sessionId: scopedSessionId })
        }
      }

      eventBus.emit({ type: 'done', data: { sessionId: scopedSessionId } })
      audit?.log({ requestId, durationMs: Date.now() - startedAt })
      return c.json(result)
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      audit?.log({ requestId, durationMs: Date.now() - startedAt, errorCode: payload.code })
      return c.json(payload, 500)
    }
  })

  // SSE 事件流路由
  app.get('/api/events', async (c) => {
    const token = c.req.query('token')
    if (token !== options.apiToken) return c.json({ code: 'UNAUTHORIZED' }, 401)

    c.header('content-type', 'text/event-stream')
    c.header('cache-control', 'no-cache')
    c.header('connection', 'keep-alive')

    let closed = false
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // 发送历史事件
    for (const event of eventBus.getHistory()) {
      await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`))
    }

    // 订阅新事件
    const unsub = eventBus.subscribe((event) => {
      if (!closed) {
        writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)).catch(() => { closed = true })
      }
    })

    // 心跳
    const heartbeat = setInterval(() => {
      if (!closed) writer.write(encoder.encode(': heartbeat\n\n')).catch(() => { closed = true })
    }, 15000)

    // 客户端断开时清理
    c.req.raw.signal?.addEventListener('abort', () => {
      closed = true
      unsub()
      clearInterval(heartbeat)
      writer.close().catch(() => {})
    })

    return c.newResponse(readable)
  })

  return { app, runtime, database, prompts, eventBus, wsExecutor, ready: seedSecret(runtime, options.llm) }
}

/** 请求鉴权：Bearer Token 比对。 */
async function authenticate(request: Request, apiToken: string): Promise<{ subject: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
  return token && token === apiToken ? { subject: 'browser-extension' } : null
}

/** 把任意错误归一化为 { code, requestId, message }。 */
function toErrorPayload(error: unknown, requestId: string): { code: string; requestId: string; message: string } {
  if (error instanceof Error && 'code' in error) {
    return { code: (error as { code: string }).code, requestId, message: error.message }
  }
  return { code: 'INTERNAL', requestId, message: '服务内部错误' }
}

/** 把环境提供的模型配置写入加密密钥库；未提供时保留库中已有配置。 */
async function seedSecret(runtime: { secrets: { put(secret: LlmSecret): Promise<void> } }, llm?: LlmSecret): Promise<void> {
  if (!llm) return
  await runtime.secrets.put(llm)
}

/** 用 Node 原生 http + ws 启动 BFF。 */
export function startServer(options: { masterKey: string; apiToken: string; port?: number; llm?: LlmSecret; llmMaxRetries?: number; llmTrace?: (event: LlmTraceEvent) => void; databasePath?: string }) {
  const { app, ready, wsExecutor } = createBrowserExtensionBff(options)
  let publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (!existsSync(publicDir)) {
    // 编译后 public 目录在 dist 的上级
    publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
  }

  const wss = new WebSocketServer({ noServer: true })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 密钥写入是异步的；先等它完成再处理请求
    await ready

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // 根路径：返回 Web UI
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const indexPath = join(publicDir, 'index.html')
      try {
        const content = readFileSync(indexPath, 'utf-8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(content)
        return
      } catch {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
    }

    // 其余请求交给 Hono
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
      body,
    })
    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  })

  // WebSocket upgrade
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname === '/api/executor') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wsExecutor.handleUpgrade(request, ws, head)
      })
    } else {
      socket.destroy()
    }
  })

  const port = options.port ?? 8787
  server.listen(port, () => console.log(`BFF listening on http://localhost:${port}`))
  return server
}

/** 读取请求体为文本（Node 原生流）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 从 exe/脚本 同目录的 .env 文件加载配置。
 *
 * 打包成 exe 后用户无法用 `set AGENT_KIT_MASTER_KEY=xxx` 逐个设环境变量，
 * 也不方便用 `--env-file`（exe 没有这个 flag）。所以在启动入口处手动读 .env，
 * 把 key=value 注入 process.env，已有的环境变量优先（命令行设置不被文件覆盖）。
 *
 * .env 文件格式：每行 `KEY=VALUE`，# 开头是注释，空行忽略。
 */
function loadEnvFile(): { loaded: boolean; path: string; vars: string[] } {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (!existsSync(envPath)) return { loaded: false, path: envPath, vars: [] }
  const content = readFileSync(envPath, 'utf-8')
  const loaded: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded.push(key)
    }
  }
  return { loaded: true, path: envPath, vars: loaded }
}

/** 生成配置文件模板（首次启动时如果 .env 不存在则写入）。 */
function ensureEnvTemplate(): void {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (existsSync(envPath)) return
  const template = [
    '# BFF 配置文件。填好后启动 exe 即可。',
    '# 井号开头是注释，不用管。',
    '',
    '# 32 字节 base64url 主密钥。用于加解密 SQLite 中的模型密钥。',
    "# 生成方法：在终端运行 openssl rand -base64 32 然后把 + 换成 -、/ 换成 _、去掉末尾 =",
    'AGENT_KIT_MASTER_KEY=',
    '',
    '# 扩展访问 BFF 的接入凭证（不是 LLM API Key）。',
    '# 随便取一个字符串，需与扩展设置里的「BFF 接入 token」一致。',
    'BFF_API_TOKEN=dev-token',
    '',
    '# 模型配置。只存在于 BFF 进程环境，扩展侧看不到。',
    'LLM_API_KEY=',
    'LLM_MODEL=deepseek-v4-flash',
    '',
    '# OpenAI 兼容端点。DeepSeek 用 https://api.deepseek.com',
    '# 火山方舟用 https://ark.cn-beijing.volces.com/api/v3',
    'LLM_BASE_URL=https://api.deepseek.com',
    '',
    '# 日志级别：info（默认）或 verbose（打印 LLM 完整输入输出，排障用）',
    '# LOG_LEVEL=verbose',
    '',
    '# LLM 请求失败重试次数（0-5，默认 3）',
    '# LLM_MAX_RETRIES=3',
    '',
    '# 监听端口（默认 8787）',
    '# PORT=8787',
    '',
  ].join('\n')
  try {
    writeFileSync(envPath, template, 'utf-8')
    console.log(`[bff] 已生成配置文件模板：${envPath}`)
    console.log('[bff] 请填写后重新启动。')
    process.exit(0)
  } catch {
    // 写不了也不阻塞 -- 用户可能手动建 .env。
  }
}

// 直接运行时启动（node dist/server.js 或 pkg 打包的 exe），被测试或库方式导入时不自动监听端口。
// 判断逻辑：pkg 打包后 process.execPath === process.argv[0]；node 直跑时用 __filename（CJS bundle）或 import.meta.url（ESM）。
// 注意：vitest 等测试运行器也会设置 process.argv[1]，所以额外检查 import.meta.url 或 __filename 必须精确匹配入口文件。
const isMainModule = process.execPath === process.argv[0] ||
  (typeof __filename !== 'undefined' && process.argv[1] === __filename && !process.env.VITEST) ||
  (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}` && !process.env.VITEST)
if (process.argv[1] && isMainModule && !process.env.VITEST) {
  // 首次启动：如果同目录没有 .env，生成模板并退出，引导用户填写。
  ensureEnvTemplate()
  // 从 .env 文件加载配置（已有的环境变量优先）。
  const envResult = loadEnvFile()
  if (envResult.loaded) {
    console.log(`[bff] 已从 ${envResult.path} 加载配置：${envResult.vars.join(', ')}`)
  }
  const masterKey = process.env.AGENT_KIT_MASTER_KEY ?? ''
  const apiToken = process.env.BFF_API_TOKEN ?? ''
  if (!masterKey || !apiToken) {
    console.error('缺少配置：AGENT_KIT_MASTER_KEY 与 BFF_API_TOKEN')
    console.error('请在 exe 同目录的 .env 文件中填写，或通过环境变量设置。')
    process.exit(1)
  }
  const apiKey = process.env.LLM_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.LLM_MODEL ?? ''
  if (!apiKey || !model) {
    console.error('缺少配置：LLM_API_KEY 与 LLM_MODEL')
    console.error('请在 exe 同目录的 .env 文件中填写，或通过环境变量设置。')
    process.exit(1)
  }
  const logLevel = process.env.LOG_LEVEL ?? 'info'
  const llmTrace =
    logLevel === 'verbose'
      ? createLlmVerboseLogger({ prefix: '[bff:llm]' })
      : undefined
  if (logLevel === 'verbose') console.log('[bff] LOG_LEVEL=verbose -- 将打印 LLM 请求与响应的完整内容（含 Prompt 正文）')
  const llmMaxRetries = Number(process.env.LLM_MAX_RETRIES ?? '3')
  const port = Number(process.env.PORT ?? '8787')
  const dbPath = join(getProgramDir(), 'agent-kit.sqlite')
  if (llmTrace) {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, llmTrace, llmMaxRetries, port, databasePath: dbPath })
  } else {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, llmMaxRetries, port, databasePath: dbPath })
  }
}
