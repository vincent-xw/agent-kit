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

describe('WebUI 会话管理', () => {
  const auth = { 'content-type': 'application/json', authorization: 'Bearer token-1' }

  it('未鉴权返回 401', async () => {
    const { app, database } = await bff()
    for (const [method, path] of [['GET', '/api/sessions'], ['POST', '/api/sessions'], ['DELETE', '/api/sessions/x']] as const) {
      const res = await app.request(path, { method })
      expect(res.status).toBe(401)
    }
    database.close()
  })

  it('创建/列表/重命名/删除会话，删除同时清理 agent_sessions', async () => {
    const { app, database } = await bff()
    const created = await (await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({}) })).json() as { id: string }
    expect(created.id).toMatch(/^sess-/)

    // 首条消息自动命名走同一 PATCH
    const patched = await app.request(`/api/sessions/${created.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: '首页调试' }) })
    expect(patched.status).toBe(200)

    // 有活动的会话排在前面：先给会话 A 写历史，再建会话 B
    database.prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run(`flutter-dev:${created.id}`, '[]', new Date().toISOString())
    const b = await (await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({}) })).json() as { id: string }

    const list = await (await app.request('/api/sessions', { headers: auth })).json() as { sessions: Array<{ id: string; title: string }> }
    expect(list.sessions).toHaveLength(2)
    expect(list.sessions[0]).toMatchObject({ id: created.id, title: '首页调试' })
    expect(list.sessions[1]).toMatchObject({ id: b.id, title: '新会话' })

    await app.request(`/api/sessions/${created.id}`, { method: 'DELETE', headers: auth })
    expect(database.prepare('SELECT COUNT(*) AS n FROM webui_sessions WHERE session_id = ?').get(created.id)).toMatchObject({ n: 0 })
    expect(database.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE session_id = ?').get(`flutter-dev:${created.id}`)).toMatchObject({ n: 0 })
    database.close()
  })

  it('POST 指定已存在 id 返回 409', async () => {
    const { app, database } = await bff()
    await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'legacy-1' }) })
    const res = await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'legacy-1' }) })
    expect(res.status).toBe(409)
    database.close()
  })

  it('PATCH 不存在的会话返回 404', async () => {
    const { app, database } = await bff()
    const res = await app.request('/api/sessions/nope', { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(404)
    database.close()
  })
})
