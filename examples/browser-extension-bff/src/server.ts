import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 获取程序所在目录。
 *
 * node 直跑时用 __filename（CJS bundle）或 import.meta.url（ESM）的目录；
 * pkg 打包后 __filename 指向虚拟 FS（/snapshot/...），此时用 process.execPath 的目录。
 */
function getProgramDir(): string {
  // CJS bundle 里有 __filename
  if (typeof __filename !== 'undefined') {
    const dir = dirname(__filename)
    // pkg 虚拟 FS 路径以 /snapshot/ 开头，此时 fallback 到 execPath
    if (!dir.startsWith('/snapshot')) return dir
  }
  // ESM 模式
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url))
    }
  } catch {
    // import.meta 不可用时 fallback
  }
  // pkg 打包的 exe：execPath 就是 exe 本身
  return dirname(process.execPath)
}

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import { createConsoleAuditLogger, createLlmVerboseLogger, createPromptRegistry } from '@agent-kit/core'
import type { AuditLogger, LlmSecret, LlmTraceEvent } from '@agent-kit/core'

import {
  browserAutomationPrompt,
  browserToolDefinitions,
  candidateAssessmentPrompt,
  candidateAssessmentProtocol,
  freeFormPrompt,
  planningPrompt,
  planningProtocol,
} from './browser-tools.js'

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
  // 审计日志：默认开启。不注入的话服务端对失败完全没有可观测性。
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[bff]' })
  const prompts = createPromptRegistry()
  // free-form 先注册因此成为默认提示词：调试期的主用途是用户下自由指令。
  // 另两个按名选择（harness.run 的 promptName）。
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'planning', version: '1', prompt: planningPrompt, protocol: planningProtocol })
  prompts.register({ name: 'browser-automation', version: '1', prompt: browserAutomationPrompt })
  prompts.register({
    name: 'candidate-assessment',
    version: '1',
    prompt: candidateAssessmentPrompt,
    protocol: candidateAssessmentProtocol,
  })
  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of browserToolDefinitions) runtime.tools.register(tool)
  const app = createAgentBff({
    // 示例鉴权：Bearer Token 与 BFF_API_TOKEN 比对；生产环境请替换为真实会话体系。
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
    audit,
  })
  return { app, runtime, database, prompts, ready: seedSecret(runtime, options.llm) }
}

/** 把环境提供的模型配置写入加密密钥库；未提供时保留库中已有配置。 */
async function seedSecret(runtime: { secrets: { put(secret: LlmSecret): Promise<void> } }, llm?: LlmSecret): Promise<void> {
  if (!llm) return
  await runtime.secrets.put(llm)
}

/** 用 Node 原生 http 启动 BFF，避免引入第三方服务器适配器。 */
export function startServer(options: { masterKey: string; apiToken: string; port?: number; llm?: LlmSecret; llmMaxRetries?: number; llmTrace?: (event: LlmTraceEvent) => void; databasePath?: string }) {
  const { app, ready } = createBrowserExtensionBff(options)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 密钥写入是异步的；先等它完成再处理请求，避免首个请求撞上 SECRET_NOT_CONFIGURED。
    await ready
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
