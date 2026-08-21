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
  vi.unstubAllEnvs()
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
  it('GET / 返回新结构 HTML', async () => {
    const { app, database } = await bff()
    const res = await app.request('/')
    // public/index.html 可能不在 dist 旁边，但状态码不应是 500
    expect([200, 404]).toContain(res.status)
    if (res.status === 200) {
      const html = await res.text()
      expect(html).toContain('id="session-list"')
      expect(html).toContain('/assets/app.js')
    }
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

    // 先建较新的会话 B，再给 A 写入更晚的 agent 活动：有活动的 A 应排在前面
    const b = await (await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({}) })).json() as { id: string }
    database.prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run(`flutter-dev:${created.id}`, '[]', new Date(Date.now() + 60_000).toISOString())

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

  it('export 端点返回 Markdown 转录', async () => {
    const { app, database } = await bff()
    await app.request('/api/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'exp-1', title: '导出测试' }) })
    const history = [
      { role: 'user', content: '启动' },
      { role: 'assistant', content: '好的', toolCalls: [{ callId: 'c1', toolName: 'flutter_run', input: { mode: 'run' } }] },
      { role: 'tool', content: { ok: true }, callId: 'c1', toolName: 'flutter_run' },
      { role: 'assistant', content: '完成' },
    ]
    database.prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run('flutter-dev:exp-1', JSON.stringify(history), new Date().toISOString())

    const res = await app.request('/api/sessions/exp-1/export', { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const md = await res.text()
    expect(md).toContain('# 会话: 导出测试')
    expect(md).toContain('## 工具调用: flutter_run')
    expect(md).toContain('"ok": true')

    // 截断档位：toolOutputLimit=5 时长输出被截断
    database.prepare("UPDATE agent_sessions SET messages = ? WHERE session_id = 'flutter-dev:exp-1'").run(JSON.stringify([
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c2', toolName: 't', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(2000) }, callId: 'c2', toolName: 't' },
    ]))
    const truncated = await (await app.request('/api/sessions/exp-1/export?toolOutputLimit=5', { headers: auth })).text()
    expect(truncated).toContain('已截断，共 ')
    database.close()
  })
})

describe('静态资源路由', () => {
  it('GET /assets/theme.css 返回 css', async () => {
    const { app, database } = await bff()
    const res = await app.request('/assets/theme.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(await res.text()).toContain('--bg:')
    database.close()
  })

  it('路径穿越与不存在文件返回 404', async () => {
    const { app, database } = await bff()
    expect((await app.request('/assets/../src/server.ts')).status).toBe(404)
    expect((await app.request('/assets/nope.css')).status).toBe(404)
    database.close()
  })
})

describe('上下文窗口端点', () => {
  const auth = { 'content-type': 'application/json', authorization: 'Bearer token-1' }

  it('GET /api/sessions/:id/context 返回上下文状态', async () => {
    const { app, database } = await bff()
    database
      .prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run('flutter-dev:ctx-1', JSON.stringify([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '好的' },
      ]), new Date().toISOString())

    const res = await app.request('/api/sessions/ctx-1/context', { headers: auth })
    expect(res.status).toBe(200)
    const status = await res.json() as { model?: string; limit?: number; used?: number; remaining?: number; compressedCount?: number }
    expect(status.model).toBeTruthy()
    // 未设置 LLM_CONTEXT_LIMIT 时回落默认 256K
    expect(status.limit).toBe(256000)
    expect(status.used).toBeGreaterThanOrEqual(0)
    expect(status.remaining).toBeGreaterThanOrEqual(0)
    expect(status.compressedCount).toBe(0)

    // 未鉴权返回 401
    expect((await app.request('/api/sessions/ctx-1/context')).status).toBe(401)
    database.close()
  })

  it('POST /api/sessions/:id/context/compact 压缩历史', async () => {
    // 压低上限以触发达成水位的压缩（仅丢弃旧工具轮次，不调用外部摘要模型）
    vi.stubEnv('LLM_CONTEXT_LIMIT', '120')
    const { app, database } = await bff()
    const history = [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
      { role: 'tool', content: { data: 'y'.repeat(500) }, callId: 'c1', toolName: 't' },
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c2', toolName: 't', input: {} }] },
      { role: 'tool', content: { data: 'z'.repeat(500) }, callId: 'c2', toolName: 't' },
      { role: 'assistant', content: '第1步' },
      { role: 'assistant', content: '第2步' },
      { role: 'assistant', content: '结果' },
    ]
    database
      .prepare('INSERT INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
      .run('flutter-dev:ctx-2', JSON.stringify(history), new Date().toISOString())

    const before = await (await app.request('/api/sessions/ctx-2/context', { headers: auth })).json() as { used?: number }
    const res = await app.request('/api/sessions/ctx-2/context/compact', { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    const after = await res.json() as { used?: number; remaining?: number; compressedCount?: number }
    expect(after.compressedCount).toBeGreaterThan(0)
    expect(after.used).toBeGreaterThanOrEqual(0)
    expect(after.remaining).toBeGreaterThanOrEqual(0)
    expect(after.used as number).toBeLessThan(before.used as number)

    // 压缩结果已持久化：占体积的工具轮次被丢弃
    const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get('flutter-dev:ctx-2') as { messages: string }
    const saved = JSON.parse(row.messages) as Array<{ role?: string }>
    expect(saved.some((m) => m.role === 'tool')).toBe(false)
    database.close()
  })
})

describe('辅助工具端点', () => {
  it('POST /api/sessions/:id/asks/:callId 无 pending 时返回 404', async () => {
    const { app, database } = await bff()
    const res = await app.request('/api/sessions/s1/asks/nope', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ answer: '允许' }),
    })
    expect(res.status).toBe(404)
    database.close()
  })
  it('未鉴权的 asks 回填返回 401', async () => {
    const { app, database } = await bff()
    const res = await app.request('/api/sessions/s1/asks/c1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '允许' }),
    })
    expect(res.status).toBe(401)
    database.close()
  })
  it('GET/POST 受信任 host 设置按会话读写', async () => {
    const { app, database } = await bff()
    const get = await app.request('/api/sessions/s1/settings', { headers: { authorization: 'Bearer token-1' } })
    expect((await get.json() as { trustedHost?: boolean }).trustedHost).toBe(false)
    const post = await app.request('/api/sessions/s1/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ trustedHost: true }),
    })
    expect((await post.json() as { ok?: boolean }).ok).toBe(true)
    const get2 = await app.request('/api/sessions/s1/settings', { headers: { authorization: 'Bearer token-1' } })
    expect((await get2.json() as { trustedHost?: boolean }).trustedHost).toBe(true)
    const other = await app.request('/api/sessions/s2/settings', { headers: { authorization: 'Bearer token-1' } })
    expect((await other.json() as { trustedHost?: boolean }).trustedHost).toBe(false)
    database.close()
  })
  it('GET/POST /api/workspace 读写全局工作区', async () => {
    const { app, database } = await bff()
    const get = await app.request('/api/workspace', { headers: { authorization: 'Bearer token-1' } })
    expect((await get.json() as { workspace?: string }).workspace).toBeTruthy()
    const post = await app.request('/api/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ workspace: '/Users/x/ws' }),
    })
    expect((await post.json() as { ok?: boolean }).ok).toBe(true)
    const get2 = await app.request('/api/workspace', { headers: { authorization: 'Bearer token-1' } })
    expect((await get2.json() as { workspace?: string }).workspace).toBe('/Users/x/ws')
    database.close()
  })
})
