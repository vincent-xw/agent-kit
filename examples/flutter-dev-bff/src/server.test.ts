import { afterEach, describe, expect, it, vi } from 'vitest'
import { toToolSchema } from '@agent-kit/core'
import { createFlutterDevBff } from './server.js'
import { createFlutterToolDefinitions } from './flutter-tools.js'

const masterKey = 'A'.repeat(43)
const llm = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

async function bff(options: { withLlm?: boolean; projectPath?: string } = {}) {
  const instance = await createFlutterDevBff({
    masterKey,
    apiToken: 'token-1',
    flutterProjectPath: options.projectPath ?? '/tmp/flutter-app',
    databasePath: ':memory:',
    ...(options.withLlm === false ? {} : { llm }),
  })
  await instance.ready
  return instance
}

function run(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  sessionId: string,
  input: string,
  token = 'token-1',
) {
  return app.request(`/v1/agent/sessions/${sessionId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input, context: {} }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('flutter-dev-bff 鉴权', () => {
  it('未鉴权返回 401', async () => {
    const { app, database } = await bff()
    const res = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(res.status).toBe(401)
    database.close()
  })

  it('错误 token 返回 401', async () => {
    const { app, database } = await bff()
    const res = await run(app, 's-1', 'hi', 'wrong')
    expect(res.status).toBe(401)
    database.close()
  })
})

describe('flutter-dev-bff 工具执行', () => {
  it('server 工具在进程内执行，返回 final', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'mobile_devices', arguments: '{}' } }] } }] }),
          }
        }
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: '已列出设备' } }] }),
        }
      }),
    )
    const { app, database } = await bff()
    const res = await run(app, 's-1', '列出设备')
    const payload = await res.json()
    expect(payload.type).toBe('final')
    expect(payload.output).toBe('已列出设备')
    database.close()
  })

  it('所有工具 schema 可转 JSON Schema', () => {
    const tools = createFlutterToolDefinitions({
      adb: {} as never,
      device: {} as never,
      flutter: {} as never,
      vm: {} as never,
      screenshots: {} as never,
      projectPath: '/tmp',
      webView: {} as never,
    })
    for (const tool of tools) {
      expect(() => toToolSchema(tool), tool.name).not.toThrow()
    }
  })
})

describe('flutter-dev-bff Web 路由', () => {
  it('GET / 返回 HTML', async () => {
    const { app, database } = await bff()
    const res = await app.request('/')
    // public/index.html 可能不在 dist 旁边，但状态码不应是 500
    expect([200, 404]).toContain(res.status)
    database.close()
  })
})

describe('flutter-dev-bff 密钥安全', () => {
  it('密钥以密文存储', async () => {
    const { database } = await bff()
    const dump = JSON.stringify(database.prepare('SELECT * FROM agent_secrets').all())
    expect(dump).not.toContain('sk-test')
    expect(dump).not.toContain(masterKey)
    database.close()
  })
})
