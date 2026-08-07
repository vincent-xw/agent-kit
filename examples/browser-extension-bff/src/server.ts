import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

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
export function startServer(options: { masterKey: string; apiToken: string; port?: number; llm?: LlmSecret; llmTrace?: (event: LlmTraceEvent) => void }) {
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

// 直接运行时启动（node dist/server.js），被测试或库方式导入时不自动监听端口。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const masterKey = process.env.AGENT_KIT_MASTER_KEY ?? ''
  const apiToken = process.env.BFF_API_TOKEN ?? ''
  if (!masterKey || !apiToken) {
    console.error('缺少环境变量：AGENT_KIT_MASTER_KEY（32 字节 base64url）与 BFF_API_TOKEN')
    process.exit(1)
  }
  // 模型配置：默认指向火山方舟的 OpenAI 兼容端点。
  const apiKey = process.env.LLM_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3'
  const model = process.env.LLM_MODEL ?? ''
  if (!apiKey || !model) {
    console.error('缺少环境变量：LLM_API_KEY 与 LLM_MODEL（可选 LLM_BASE_URL，默认火山方舟）')
    process.exit(1)
  }
  // LOG_LEVEL=verbose 时打印每次 LLM 调用的完整输入输出（含 Prompt 正文与模型原文）。
  // 这是有意越界的调试模式，只应在排查问题时临时开启。
  const logLevel = process.env.LOG_LEVEL ?? 'info'
  const llmTrace =
    logLevel === 'verbose'
      ? createLlmVerboseLogger({ prefix: '[bff:llm]' })
      : undefined
  if (logLevel === 'verbose') console.log('[bff] LOG_LEVEL=verbose —— 将打印 LLM 请求与响应的完整内容（含 Prompt 正文）')
  if (llmTrace) {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, llmTrace })
  } else {
    startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model } })
  }
}
