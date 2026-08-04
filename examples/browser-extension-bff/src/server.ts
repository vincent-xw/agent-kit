import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'

/** 装配浏览器扩展专属 BFF：SQLite 密钥库 + Bearer 鉴权 + harness HTTP 边界。 */
export function createBrowserExtensionBff(options: { masterKey: string; apiToken: string; databasePath?: string }) {
  // 主密钥只存在于 BFF 进程环境，绝不写入 SQLite，也绝不暴露给浏览器扩展。
  const database = new DatabaseSync(options.databasePath ?? 'agent-kit.sqlite')
  const runtime = createSqliteAgentRuntime({ database, masterKey: options.masterKey })
  const app = createAgentBff({
    // 示例鉴权：Bearer Token 与 BFF_API_TOKEN 比对；生产环境请替换为真实会话体系。
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
  })
  return { app, runtime, database }
}

/** 用 Node 原生 http 启动 BFF，避免引入第三方服务器适配器。 */
export function startServer(options: { masterKey: string; apiToken: string; port?: number }) {
  const { app } = createBrowserExtensionBff(options)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
  startServer({ masterKey, apiToken })
}
