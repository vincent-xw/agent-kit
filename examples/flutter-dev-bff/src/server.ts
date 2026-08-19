import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    // ignore
  }
  return dirname(process.execPath)
}

import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import {
  createConsoleAuditLogger,
  createLlmClient,
  createLlmVerboseLogger,
  createPromptRegistry,
} from '@agent-kit/core'
import type { AuditLogger, LlmClient, LlmSecret, LlmTraceEvent } from '@agent-kit/core'

import { createFlutterToolDefinitions } from './flutter-tools.js'
import { debuggingPrompt, freeFormPrompt, testingPrompt } from './prompts.js'
import { AdbClient } from './services/adb-client.js'
import { UiAutomatorDumpProvider } from './services/uiautomator-provider.js'
import { CompanionProvider } from './services/companion-provider.js'
import type { SnapshotProvider } from './services/device-provider.js'
import { FlutterProcessManager } from './services/flutter-process-manager.js'
import { VmServiceClient } from './services/vm-service-client.js'
import { ScreenshotStore } from './services/screenshot-store.js'
import { createEventBus } from './services/event-bus.js'
import { CdpClient } from './services/webview/cdp-client.js'
import { ToolLoader } from './services/tool-loader.js'
import { homedir } from 'node:os'
import { VisionClient } from './services/vision-client.js'
import type { VisionClientConfig } from './services/vision-client.js'
import { SkillStore } from './services/skill-store.js'
import { generateSkill, optimizeSkill } from './services/skill-generator.js'
import type { FlutterEvent } from './services/event-bus.js'
import { instrumentTools, llmTraceToBus } from './tool-events.js'

export async function createFlutterDevBff(options: {
  masterKey: string
  apiToken: string
  flutterProjectPath: string
  databasePath?: string
  screenshotDir?: string
  llm?: LlmSecret
  audit?: AuditLogger
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
  vision?: VisionClientConfig
}) {
  const database = new DatabaseSync(options.databasePath ?? 'flutter-dev-bff.sqlite')
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[flutter-bff]' })
  const programDir = getProgramDir()
  const screenshotDir = options.screenshotDir ?? join(programDir, 'screenshots')
  const skillsDir = join(programDir, 'skills')
  // dev 模式下 public/ 在源码根目录（dist 的上一级）；pkg 打包后在 exe 同目录
  const publicDir = existsSync(join(programDir, 'public'))
    ? join(programDir, 'public')
    : join(programDir, '..', 'public')

  const adb = new AdbClient()
  const device: SnapshotProvider = process.env.COMPANION_ENABLED === '1'
    ? new CompanionProvider(adb)
    : new UiAutomatorDumpProvider(adb)
  const webView = new CdpClient(adb)
  const flutter = new FlutterProcessManager({ projectPath: options.flutterProjectPath })
  const screenshots = new ScreenshotStore(screenshotDir)
  const skillStore = new SkillStore(skillsDir)

  // 加载用户自定义工具插件：全局 ~/.agentkit/tools + 项目 ./tools
  const globalToolsDir = join(homedir(), '.agentkit', 'tools')
  const projectToolsDir = join(process.cwd(), 'tools')
  const toolLoader = new ToolLoader({ globalDir: globalToolsDir, projectDir: projectToolsDir })
  const pluginTools = await toolLoader.loadAll()
  if (pluginTools.length > 0) {
    audit.log?.({ requestId: `tool-loader-${Date.now()}`, durationMs: 0, toolName: pluginTools.map((t) => t.name).join(',') })
  }

  let vmClient: VmServiceClient | null = null

  const toolDefinitions = createFlutterToolDefinitions({
    adb,
    device,
    flutter,
    vm: {
      get current() { return vmClient },
      async connect(uri: string) {
        vmClient?.disconnect()
        vmClient = new VmServiceClient(uri)
        await vmClient.connect()
        return vmClient
      },
      disconnect() {
        vmClient?.disconnect()
        vmClient = null
      },
    },
    screenshots,
    projectPath: options.flutterProjectPath,
    webView,
    ...(options.vision ? { vision: new VisionClient(options.vision) } : {}),
  })

  // 插件工具与内置工具合并，同名以插件为准（Map 去重）
  let finalTools = new Map([...toolDefinitions, ...pluginTools].map((t) => [t.name, t]))
  const finalToolList = [...finalTools.values()]

  const bus = createEventBus()

  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'debugging', version: '1', prompt: debuggingPrompt })
  prompts.register({ name: 'testing', version: '1', prompt: testingPrompt })

  // 启动时把磁盘上已有的 skills 注册为可选系统提示词（skill-<slug>）
  for (const s of skillStore.list()) {
    const skill = skillStore.get(s.slug)
    if (skill) prompts.register({ name: `skill-${s.slug}`, version: skill.meta.version, prompt: skill.prompt })
  }

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    maxSteps: 50,
    ...(options.llmTrace
      ? {
          llmTrace: (event: LlmTraceEvent) => {
            options.llmTrace?.(event)
            llmTraceToBus(bus)(event)
          },
        }
      : {}),
    llmDelta: (delta) => {
      bus.emit({ type: 'llm_delta', ...delta })
    },
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of instrumentTools(finalToolList, bus)) runtime.tools.register(tool)

  // Skill 生成用的 LLM 客户端：每次调用前从 secrets 读取最新密钥。
  const skillLlm: LlmClient = {
    complete: async (request) => {
      const secret = (await runtime.secrets.get()) as LlmSecret
      return createLlmClient({
        ...secret,
        ...(options.llmMaxRetries !== undefined ? { maxRetries: options.llmMaxRetries } : {}),
      }).complete(request)
    },
  }

  const app = createAgentBff({
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'flutter-dev' } : null
    },
    harness: runtime.harness,
    audit,
  })

  app.get('/', (c) => {
    const htmlPath = join(publicDir, 'index.html')
    if (!existsSync(htmlPath)) return c.text('Web UI not found.', 404)
    return c.html(readFileSync(htmlPath, 'utf-8'))
  })

  app.get('/api/sessions/:sessionId/messages', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '')
    if (token !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const scopedId = `flutter-dev:${c.req.param('sessionId')}`
    const row = database
      .prepare('SELECT messages FROM agent_sessions WHERE session_id = ?')
      .get(scopedId) as { messages?: string } | undefined
    if (!row?.messages) return c.json({ messages: [] })
    return c.json({ messages: JSON.parse(row.messages) })
  })

  // ── Skills ──────────────────────────────────────────────
  app.get('/api/history', (c) => {
    return c.json({ runs: skillStore.getAllRuns() })
  })

  app.get('/api/skills', (c) => {
    return c.json({ skills: skillStore.list() })
  })

  app.get('/api/skills/:slug', (c) => {
    const skill = skillStore.get(c.req.param('slug'))
    if (!skill) return c.json({ error: 'not found' }, 404)
    return c.json(skill)
  })

  app.post('/api/skills/generate', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const intent = typeof body?.intent === 'string' ? body.intent.trim() : ''
    if (!intent) return c.json({ error: 'intent is required' }, 400)
    try {
      const generated = await generateSkill(skillLlm, finalToolList, intent)
      return c.json(generated)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  app.post('/api/skills/:slug', async (c) => {
    const slug = c.req.param('slug')
    const body = await c.req.json().catch(() => ({}))
    if (!body?.name || !body?.prompt) return c.json({ error: 'name and prompt required' }, 400)
    const now = new Date().toISOString()
    const existing = skillStore.get(slug)
    const meta = {
      name: body.name,
      description: body.description ?? '',
      icon: body.icon,
      version: existing?.meta.version ?? '1.0.0',
      tools: body.tools,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
    }
    skillStore.save(slug, meta, body.prompt)
    // 把 skill 的 prompt 注册为可选用的系统提示词，运行时用 promptName=skill-<slug>
    prompts.register({ name: `skill-${slug}`, version: meta.version, prompt: body.prompt })
    return c.json({ slug, meta })
  })

  app.delete('/api/skills/:slug', (c) => {
    skillStore.delete(c.req.param('slug'))
    return c.json({ ok: true })
  })

  app.post('/api/skills/:slug/optimize', async (c) => {
    try {
      const slug = c.req.param('slug')
      const skill = skillStore.get(slug)
      if (!skill) return c.json({ error: 'not found' }, 404)
      const result = await optimizeSkill(skillLlm, finalToolList, skill.prompt, skill.runs, skill.meta.version)
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/skills/:slug/apply', async (c) => {
    try {
      const slug = c.req.param('slug')
      const body = await c.req.json<{ prompt: string; version: string }>()
      if (!body.prompt) return c.json({ error: 'prompt 不能为空' }, 400)
      skillStore.updatePrompt(slug, body.prompt, body.version)
      return c.json({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 500)
    }
  })

  app.get('/api/screenshots/:id', (c) => {
    const id = c.req.param('id')
    if (!/^[\w-]+$/.test(id)) return c.json({ error: 'invalid id' }, 400)
    const filePath = screenshots.getPath(id)
    if (!existsSync(filePath)) return c.json({ error: 'not found' }, 404)
    const stat = statSync(filePath)
    c.header('Content-Type', 'image/png')
    c.header('Content-Length', String(stat.size))
    return c.body(readFileSync(filePath))
  })

  app.get('/api/events', (c) => {
    // 浏览器 EventSource 不支持自定义请求头，因此 token 走查询参数。
    // 服务只绑 loopback，接受 token 落入日志的代价以换取 EventSource 自带的重连。
    if (c.req.query('token') !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const lastEventId = c.req.header('last-event-id')
    const fromSeq = lastEventId !== undefined ? Number(lastEventId) : undefined

    return streamSSE(c as unknown as Parameters<typeof streamSSE>[0], async (stream) => {
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

  const ready = seedSecret(runtime, options.llm)
  return { app, runtime, database, prompts, adb, flutter, bus, toolLoader, ready }
}

export function startFlutterDevBffServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  port: number,
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: fetchHandler, port, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, port: info.port })
    })
  })
}

async function seedSecret(
  rt: { secrets: { put(secret: LlmSecret): Promise<void> } },
  llm?: LlmSecret,
): Promise<void> {
  if (!llm) return
  await rt.secrets.put(llm)
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
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded.push(key)
    }
  }
  return { loaded: true, path: envPath, vars: loaded }
}

function ensureEnvTemplate(): void {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (existsSync(envPath)) return
  const template = [
    '# Flutter 开发辅助 BFF 配置文件',
    '',
    '# 32 字节 base64url 主密钥（openssl rand -base64 32 | tr +/ -_ | tr -d =）',
    'AGENT_KIT_MASTER_KEY=',
    '',
    '# Web UI 和 API 访问令牌',
    'BFF_API_TOKEN=dev-token',
    '',
    '# Flutter 项目路径（含 pubspec.yaml 的目录）',
    'FLUTTER_PROJECT_PATH=/path/to/your/flutter/app',
    '',
    '# 模型配置（只存在于 BFF 进程环境）',
    'LLM_API_KEY=',
    'LLM_MODEL=deepseek-chat',
    'LLM_BASE_URL=https://api.deepseek.com',
    '',
    '# 日志级别：info 或 verbose',
    '# LOG_LEVEL=verbose',
    '# LLM_MAX_RETRIES=3',
    '# PORT=8788',
    '',
  ].join('\n')
  try {
    writeFileSync(envPath, template, 'utf-8')
    console.log(`[flutter-bff] 已生成配置文件模板：${envPath}`)
    console.log('[flutter-bff] 请填写后重新启动。')
    process.exit(0)
  } catch {
    // ignore
  }
}

const isMainModule = process.execPath === process.argv[0] ||
  (typeof __filename !== 'undefined' && process.argv[1] === __filename && !process.env.VITEST) ||
  (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}` && !process.env.VITEST)

if (process.argv[1] && isMainModule && !process.env.VITEST) {
  ensureEnvTemplate()
  const envResult = loadEnvFile()
  if (envResult.loaded) {
    console.log(`[flutter-bff] 已从 ${envResult.path} 加载配置：${envResult.vars.join(', ')}`)
  }
  const masterKey = process.env.AGENT_KIT_MASTER_KEY ?? ''
  const apiToken = process.env.BFF_API_TOKEN ?? ''
  const projectPath = process.env.FLUTTER_PROJECT_PATH ?? ''
  if (!masterKey || !apiToken || !projectPath) {
    console.error('缺少配置：AGENT_KIT_MASTER_KEY、BFF_API_TOKEN、FLUTTER_PROJECT_PATH')
    process.exit(1)
  }
  const apiKey = process.env.LLM_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.LLM_MODEL ?? ''
  if (!apiKey || !model) {
    console.error('缺少配置：LLM_API_KEY 与 LLM_MODEL')
    process.exit(1)
  }
  const logLevel = process.env.LOG_LEVEL ?? 'info'
  const llmTrace = logLevel === 'verbose' ? createLlmVerboseLogger({ prefix: '[flutter-bff:llm]' }) : undefined
  if (llmTrace) console.log('[flutter-bff] LOG_LEVEL=verbose')
  const llmMaxRetries = Number(process.env.LLM_MAX_RETRIES ?? '3')
  const port = Number(process.env.PORT ?? '8788')
  const dbPath = join(getProgramDir(), 'flutter-dev-bff.sqlite')

  const vision =
    process.env.VISION_API_KEY && process.env.VISION_MODEL && process.env.VISION_BASE_URL
      ? { apiKey: process.env.VISION_API_KEY, baseUrl: process.env.VISION_BASE_URL, model: process.env.VISION_MODEL }
      : undefined
  if (vision) console.log(`[flutter-bff] 视觉模型已配置: ${vision.model}`)

  const bff = await createFlutterDevBff({
    masterKey,
    apiToken,
    flutterProjectPath: projectPath,
    databasePath: dbPath,
    llm: { apiKey, baseUrl, model },
    ...(llmTrace ? { llmTrace } : {}),
    llmMaxRetries,
    ...(vision ? { vision } : {}),
  })

  await bff.ready
  const { server } = await startFlutterDevBffServer((request) => bff.app.fetch(request), port)
  console.log(`Flutter Dev BFF listening on http://localhost:${port}`)

  const shutdown = async () => {
    console.log('\n[flutter-bff] 正在关闭...')
    await bff.flutter.stop().catch(() => {})
    bff.database.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
