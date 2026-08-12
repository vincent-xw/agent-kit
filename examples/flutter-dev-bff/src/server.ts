import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import {
  createConsoleAuditLogger,
  createLlmVerboseLogger,
  createPromptRegistry,
} from '@agent-kit/core'
import type { AuditLogger, LlmSecret, LlmTraceEvent } from '@agent-kit/core'

import { createFlutterToolDefinitions } from './flutter-tools.js'
import { debuggingPrompt, freeFormPrompt, testingPrompt } from './prompts.js'
import { AdbClient } from './services/adb-client.js'
import { UiAutomatorDumpProvider } from './services/uiautomator-provider.js'
import { FlutterProcessManager } from './services/flutter-process-manager.js'
import { VmServiceClient } from './services/vm-service-client.js'
import { ScreenshotStore } from './services/screenshot-store.js'

export function createFlutterDevBff(options: {
  masterKey: string
  apiToken: string
  flutterProjectPath: string
  databasePath?: string
  screenshotDir?: string
  llm?: LlmSecret
  audit?: AuditLogger
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
}) {
  const database = new DatabaseSync(options.databasePath ?? 'flutter-dev-bff.sqlite')
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[flutter-bff]' })
  const programDir = getProgramDir()
  const screenshotDir = options.screenshotDir ?? join(programDir, 'screenshots')
  // dev 模式下 public/ 在源码根目录（dist 的上一级）；pkg 打包后在 exe 同目录
  const publicDir = existsSync(join(programDir, 'public'))
    ? join(programDir, 'public')
    : join(programDir, '..', 'public')

  const adb = new AdbClient()
  const device = new UiAutomatorDumpProvider(adb)
  const flutter = new FlutterProcessManager({ projectPath: options.flutterProjectPath })
  const screenshots = new ScreenshotStore(screenshotDir)

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
  })

  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'debugging', version: '1', prompt: debuggingPrompt })
  prompts.register({ name: 'testing', version: '1', prompt: testingPrompt })

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    maxSteps: 50,
    ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of toolDefinitions) runtime.tools.register(tool)

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

  const ready = seedSecret(runtime, options.llm)
  return { app, runtime, database, prompts, adb, flutter, ready }
}

async function seedSecret(
  rt: { secrets: { put(secret: LlmSecret): Promise<void> } },
  llm?: LlmSecret,
): Promise<void> {
  if (!llm) return
  await rt.secrets.put(llm)
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

  const bff = createFlutterDevBff({
    masterKey,
    apiToken,
    flutterProjectPath: projectPath,
    databasePath: dbPath,
    llm: { apiKey, baseUrl, model },
    ...(llmTrace ? { llmTrace } : {}),
    llmMaxRetries,
  })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await bff.ready
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
    const response = await bff.app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  })
  server.listen(port, () => console.log(`Flutter Dev BFF listening on http://localhost:${port}`))

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
