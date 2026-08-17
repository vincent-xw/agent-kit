import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, writeFileSync, createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

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
  } catch { /* fallback */ }
  return dirname(process.execPath)
}

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import { createConsoleAuditLogger, createContextManager, createLlmVerboseLogger, createPromptRegistry } from '@agent-kit/core'
import type { AuditLogger, LlmSecret, LlmTraceEvent, ToolDefinition } from '@agent-kit/core'
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
import { createWsExecutor } from './ws-executor.js'
import { createFileStorage } from './file-storage.js'
import { createSkillStore } from './skill-store.js'
import { createSessionStore } from './session-store.js'

/** 构造文件操作的 server 端工具。 */
function createFileTools(fileStorage: ReturnType<typeof createFileStorage>): ToolDefinition[] {
  return [
    {
      name: 'browser_save_file',
      execution: 'server',
      description: '生成文件供用户下载。当任务需要把收集到的数据导出时调用此工具。支持 txt/csv/xlsx/json。xlsx 的 content 传 base64 编码的二进制。',
      input: z.object({
        filename: z.string(),
        format: z.enum(['txt', 'csv', 'xlsx', 'json']),
        content: z.string(),
      }),
      output: z.object({
        ok: z.boolean(),
        message: z.string(),
        fileId: z.string().optional(),
        filename: z.string().optional(),
      }),
      execute: async (input: unknown) => {
        const { filename, format, content } = input as { filename: string; format: 'txt' | 'csv' | 'xlsx' | 'json'; content: string }
        const file = fileStorage.saveGeneratedFile(filename, format, content)
        return { ok: true, message: `文件已生成：${file.filename}`, fileId: file.id, filename: file.filename }
      },
    },
    {
      name: 'browser_read_file',
      execution: 'server',
      description: '从 BFF 文件存储读取文本文件。用户上传的文件和之前会话写入的文件跨会话可用。大文件自动截断前 50000 字符。',
      input: z.object({
        name: z.string(),
      }),
      output: z.object({
        ok: z.boolean(),
        name: z.string().optional(),
        content: z.string().optional(),
        size: z.number().optional(),
        truncated: z.boolean().optional(),
        totalLength: z.number().optional(),
        message: z.string(),
      }),
      execute: async (input: unknown) => {
        const { name } = input as { name: string }
        return fileStorage.readFile(name)
      },
    },
    {
      name: 'browser_write_file',
      execution: 'server',
      description: '将文本内容写入 BFF 文件存储，跨会话可用。适合保存中间结果。只支持文本格式。',
      input: z.object({
        name: z.string(),
        content: z.string(),
      }),
      output: z.object({
        ok: z.boolean(),
        name: z.string().optional(),
        size: z.number().optional(),
        message: z.string(),
      }),
      execute: async (input: unknown) => {
        const { name, content } = input as { name: string; content: string }
        const file = fileStorage.saveTextFile(name, content)
        return { ok: true, name: file.filename, size: file.size, message: `已保存：${file.filename}` }
      },
    },
  ]
}

export function createBrowserExtensionBff(options: {
  masterKey: string
  apiToken: string
  databasePath?: string
  llm?: LlmSecret
  audit?: AuditLogger
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
}) {
  const database = new DatabaseSync(options.databasePath ?? join(getProgramDir(), 'agent-kit.sqlite'))
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[bff]' })
  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'planning', version: '1', prompt: planningPrompt, protocol: planningProtocol })
  prompts.register({ name: 'browser-automation', version: '1', prompt: browserAutomationPrompt })
  prompts.register({ name: 'candidate-assessment', version: '1', prompt: candidateAssessmentPrompt, protocol: candidateAssessmentProtocol })

  const eventBus = createEventBus()
  const contextManager = createContextManager({ maxMessages: 200 })
  const fileStorage = createFileStorage({ dataDir: join(getProgramDir(), 'data', 'files') })
  const skillStore = createSkillStore(database)
  const sessionMeta = createSessionStore(database)

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    context: contextManager,
    maxSteps: 50,
    ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })

  // 注册 remote 工具
  for (const tool of browserToolDefinitions) runtime.tools.register(tool)
  // 注册 server 端文件工具
  for (const tool of createFileTools(fileStorage)) runtime.tools.register(tool)

  // WebSocket 执行器
  const wsExecutor = createWsExecutor({
    authenticate: async (req) => {
      const token = req.url?.match(/[?&]token=([^&]+)/)?.[1] ?? ''
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    onConnectionChange: (online: boolean, info?: { tabUrl?: string; tabTitle?: string }) => {
      eventBus.emit({ type: 'executor_status', data: { online, ...info } })
    },
  })

  // Hono app
  const app = createAgentBff({
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
    audit,
  })

  // 鉴权辅助
  async function authHeader(c: { req: { raw: Request } }): Promise<boolean> {
    const token = c.req.raw.headers.get('authorization')?.replace(/^Bearer\s+/, '')
    return token === options.apiToken
  }
  function authQuery(c: { req: { query: (k: string) => string | undefined } }): boolean {
    return c.req.query('token') === options.apiToken
  }

  // 覆盖 run 路由：BFF 侧驱动工具循环
  app.post('/v1/agent/sessions/:sessionId/run', async (c) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      if (!await authHeader(c)) {
        return c.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await c.req.json<{ input?: unknown; context?: unknown; promptName?: unknown; skipTools?: unknown }>()
      if (typeof body.input !== 'string' || !body.input.trim() || !body.context || typeof body.context !== 'object') {
        return c.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }

      const shortId = c.req.param('sessionId')
      const scopedSessionId = `browser-extension:${shortId}`
      sessionMeta.ensure(shortId)

      // 注入 fileList 到 context
      const context = { ...(body.context as Record<string, unknown>) }
      const fileList = fileStorage.buildFileList()
      if (fileList.length > 0) context.fileList = fileList

      let result = await runtime.harness.run({
        sessionId: scopedSessionId,
        input: body.input,
        context,
        ...(body.promptName ? { promptName: body.promptName as string } : {}),
        ...(body.skipTools === true ? { skipTools: true } : {}),
        stepMode: true,
      })

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
              // 截图特殊处理：base64 存磁盘，返回 fileId
              if (call.toolName === 'browser_screenshot' && output && typeof output === 'object') {
                const o = output as Record<string, unknown>
                if (o.dataUrl && typeof o.dataUrl === 'string') {
                  const shot = fileStorage.saveScreenshot(o.dataUrl as string, Number(o.width) || 0, Number(o.height) || 0)
                  output = { screenshotId: shot.id, width: shot.width, height: shot.height, persisted: true, message: '截图已保存' }
                }
              }
            } catch (error) {
              output = { ok: false, code: 'EXECUTOR_ERROR', message: error instanceof Error ? error.message : '执行器错误' }
            }
            const durationMs = Date.now() - startedAt
            const isOk = !(typeof output === 'object' && output && (output as Record<string, unknown>).ok === false)
            eventBus.emit({ type: 'tool_end', data: { callId: call.callId, toolName: call.toolName, ok: isOk, outputPreview: output, durationMs } })

            result = await runtime.harness.resume({ sessionId: scopedSessionId, callId: call.callId, output })
          }
        } else if (result.type === 'step_done') {
          result = await runtime.harness.continue({ sessionId: scopedSessionId })
        }
      }

      sessionMeta.touch(shortId)

      // 自动生成会话标题（异步，不阻塞响应）
      const meta = sessionMeta.get(shortId)
      if (meta && !meta.titleGenerated) {
        void generateSessionTitle(runtime, scopedSessionId, shortId, body.input, sessionMeta, audit).catch(() => {})
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

  // SSE
  app.get('/api/events', async (c) => {
    if (!authQuery(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    c.header('content-type', 'text/event-stream')
    c.header('cache-control', 'no-cache')
    c.header('connection', 'keep-alive')

    let closed = false
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    for (const event of eventBus.getHistory()) {
      await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`))
    }
    const unsub = eventBus.subscribe((event) => {
      if (!closed) writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)).catch(() => { closed = true })
    })
    const heartbeat = setInterval(() => {
      if (!closed) writer.write(encoder.encode(': heartbeat\n\n')).catch(() => { closed = true })
    }, 15000)
    c.req.raw.signal?.addEventListener('abort', () => {
      closed = true; unsub(); clearInterval(heartbeat); writer.close().catch(() => {})
    })
    return c.newResponse(readable)
  })

  // 消息历史
  app.get('/api/sessions/:sessionId/messages', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    const scopedId = `browser-extension:${c.req.param('sessionId')}`
    const messages = await runtime.sessions.load(scopedId)
    return c.json({ messages })
  })

  // 会话列表
  app.get('/api/sessions', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    return c.json({ sessions: sessionMeta.list() })
  })

  // 删除会话
  app.delete('/api/sessions/:sessionId', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    sessionMeta.delete(`browser-extension:${c.req.param('sessionId')}`)
    return c.json({ ok: true })
  })

  // Skills CRUD
  app.get('/api/skills', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    return c.json({ skills: skillStore.list() })
  })
  app.post('/api/skills', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    const body = await c.req.json<{ name: string; firstInstruction: string; finalReplySummary: string }>()
    const skill = skillStore.save(body.name, body.firstInstruction, body.finalReplySummary)
    return c.json({ skill })
  })
  app.delete('/api/skills/:id', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    skillStore.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // 文件列表
  app.get('/api/files', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    return c.json({ files: fileStorage.listFiles() })
  })

  // 文件下载
  app.get('/api/files/:id/download', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    const filePath = fileStorage.getFilePath(c.req.param('id'))
    if (!filePath) return c.json({ code: 'NOT_FOUND' }, 404)
    const file = fileStorage.getFile(c.req.param('id'))
    const nodeRes = (c.env as Record<string, unknown>)?.nodeRes as ServerResponse | undefined
    if (nodeRes) {
      nodeRes.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(file?.filename || 'download')}"`)
      nodeRes.setHeader('content-type', 'application/octet-stream')
      createReadStream(filePath).pipe(nodeRes)
      return c.newResponse(null)
    }
    const content = readFileSync(filePath)
    return new Response(content, {
      headers: {
        'content-disposition': `attachment; filename="${encodeURIComponent(file?.filename || 'download')}"`,
        'content-type': 'application/octet-stream',
      },
    })
  })

  // 文件删除
  app.delete('/api/files/:id', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    fileStorage.deleteFile(c.req.param('id'))
    return c.json({ ok: true })
  })

  // 文件上传
  app.post('/api/files/upload', async (c) => {
    if (!await authHeader(c)) return c.json({ code: 'UNAUTHORIZED' }, 401)
    const formData = await c.req.raw.formData()
    const file = formData.get('file') as File | null
    if (!file) return c.json({ code: 'NO_FILE' }, 400)
    const content = await file.text()
    const saved = fileStorage.saveTextFile(file.name, content)
    return c.json({ file: saved })
  })

  return { app, runtime, database, prompts, eventBus, wsExecutor, fileStorage, skillStore, sessionMeta, ready: seedSecret(runtime, options.llm) }
}

async function generateSessionTitle(
  runtime: { harness: { run: (r: { sessionId: string; input: string; context: Record<string, unknown>; promptName: string; skipTools: boolean }) => Promise<{ type: string; output?: unknown; reasoning?: string }> } },
  scopedId: string,
  shortId: string,
  firstInput: string,
  sessionMeta: ReturnType<typeof createSessionStore>,
  audit: AuditLogger | undefined,
) {
  try {
    const result = await runtime.harness.run({
      sessionId: scopedId,
      input: `根据以下对话内容，生成一个10-20字的中文标题，概括这个任务的主题。只输出标题文本，不要标点、不要解释、不要引号。\n\n${firstInput.slice(0, 500)}`,
      context: {},
      promptName: 'planning',
      skipTools: true,
    })
    if (result.type === 'final' && typeof result.output === 'string') {
      const title = result.output.trim().slice(0, 30)
      if (title) sessionMeta.updateTitle(shortId, title)
    }
  } catch (error) {
    audit?.log({ requestId: 'title-gen', durationMs: 0, errorCode: error instanceof Error ? error.message : 'title gen failed' })
  }
}

async function authenticate(request: Request, apiToken: string): Promise<{ subject: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
  return token && token === apiToken ? { subject: 'browser-extension' } : null
}

function toErrorPayload(error: unknown, requestId: string): { code: string; requestId: string; message: string } {
  if (error instanceof Error && 'code' in error) {
    return { code: (error as { code: string }).code, requestId, message: error.message }
  }
  return { code: 'INTERNAL', requestId, message: '服务内部错误' }
}

async function seedSecret(runtime: { secrets: { put(secret: LlmSecret): Promise<void> } }, llm?: LlmSecret): Promise<void> {
  if (!llm) return
  await runtime.secrets.put(llm)
}

export function startServer(options: { masterKey: string; apiToken: string; port?: number; llm?: LlmSecret; llmMaxRetries?: number; llmTrace?: (event: LlmTraceEvent) => void; databasePath?: string }) {
  const { app, ready, wsExecutor } = createBrowserExtensionBff(options)
  let publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (!existsSync(publicDir)) {
    publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
  }

  const wss = new WebSocketServer({ noServer: true })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await ready
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const content = readFileSync(join(publicDir, 'index.html'), 'utf-8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(content)
      } catch {
        res.writeHead(404); res.end('Not Found')
      }
      return
    }

    // 文件下载特殊处理（需要 Node res 流）
    if (req.method === 'GET' && url.pathname.startsWith('/api/files/') && url.pathname.endsWith('/download')) {
      const token = url.searchParams.get('token')
      if (token !== options.apiToken) { res.writeHead(401); res.end('Unauthorized'); return }
      const id = url.pathname.split('/')[3]
      // 交给 Hono 处理，传入 nodeRes
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
      }
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
      const response = await app.fetch(request, { nodeRes: res })
      if (!res.writableEnded) {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        const buf = Buffer.from(await response.arrayBuffer())
        res.end(buf)
      }
      return
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, body })
    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  })

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

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
    if (process.env[key] === undefined) { process.env[key] = value; loaded.push(key) }
  }
  return { loaded: true, path: envPath, vars: loaded }
}

function ensureEnvTemplate(): void {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (existsSync(envPath)) return
  const template = [
    '# BFF 配置文件。',
    'AGENT_KIT_MASTER_KEY=',
    'BFF_API_TOKEN=dev-token',
    'LLM_API_KEY=',
    'LLM_MODEL=deepseek-v4-flash',
    'LLM_BASE_URL=https://api.deepseek.com',
    '# LOG_LEVEL=verbose',
    '# LLM_MAX_RETRIES=3',
    '# PORT=8787',
    '',
  ].join('\n')
  try {
    writeFileSync(envPath, template, 'utf-8')
    console.log(`[bff] 已生成配置文件模板：${envPath}`)
    process.exit(0)
  } catch { /* ignore */ }
}

const isMainModule = process.execPath === process.argv[0] ||
  (typeof __filename !== 'undefined' && process.argv[1] === __filename && !process.env.VITEST) ||
  (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}` && !process.env.VITEST)

if (process.argv[1] && isMainModule && !process.env.VITEST) {
  ensureEnvTemplate()
  const envResult = loadEnvFile()
  if (envResult.loaded) console.log(`[bff] 已从 ${envResult.path} 加载配置：${envResult.vars.join(', ')}`)
  const masterKey = process.env.AGENT_KIT_MASTER_KEY ?? ''
  const apiToken = process.env.BFF_API_TOKEN ?? ''
  if (!masterKey || !apiToken) { console.error('缺少 AGENT_KIT_MASTER_KEY 与 BFF_API_TOKEN'); process.exit(1) }
  const apiKey = process.env.LLM_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.LLM_MODEL ?? ''
  if (!apiKey || !model) { console.error('缺少 LLM_API_KEY 与 LLM_MODEL'); process.exit(1) }
  const logLevel = process.env.LOG_LEVEL ?? 'info'
  const llmTrace = logLevel === 'verbose' ? createLlmVerboseLogger({ prefix: '[bff:llm]' }) : undefined
  const llmMaxRetries = Number(process.env.LLM_MAX_RETRIES ?? '3')
  const port = Number(process.env.PORT ?? '8787')
  const dbPath = join(getProgramDir(), 'agent-kit.sqlite')
  if (llmTrace) {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, llmTrace, llmMaxRetries, port, databasePath: dbPath })
  } else {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, llmMaxRetries, port, databasePath: dbPath })
  }
}