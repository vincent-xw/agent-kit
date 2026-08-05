import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserExtensionBff } from './server.js'
import { browserToolDefinitions } from './browser-tools.js'

const masterKey = 'A'.repeat(43)
const llm = { apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

/** 装配一个内存 BFF，并等待密钥写入完成。 */
async function bff(options: { apiToken?: string; withLlm?: boolean } = {}) {
  const instance = createBrowserExtensionBff({
    masterKey,
    apiToken: options.apiToken ?? 'token-1',
    databasePath: ':memory:',
    ...(options.withLlm === false ? {} : { llm }),
  })
  await instance.ready
  return instance
}

/** 让模型返回一次工具调用。 */
function stubToolCall(toolName: string, args: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: toolName, arguments: JSON.stringify(args) } }] } }] }),
    })),
  )
}

/** 让模型返回最终文本。 */
function stubFinal(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })))
}

/** 带鉴权的 run 请求。 */
function run(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  sessionId: string,
  input: string,
  token = 'token-1',
): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ input, context: {} }),
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser-extension-bff 鉴权与密钥边界', () => {
  it('未鉴权请求返回 401 且不发起模型调用', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, database } = await bff()
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(fetchMock).not.toHaveBeenCalled()
    database.close()
  })

  it('接入 token 不匹配返回 401', async () => {
    const { app, database } = await bff({ apiToken: 'right' })
    const response = await run(app, 's-1', 'hi', 'wrong')
    expect(response.status).toBe(401)
    database.close()
  })

  it('拒绝非 32 字节主密钥', () => {
    expect(() => createBrowserExtensionBff({ masterKey: 'short', apiToken: 't', databasePath: ':memory:' })).toThrowError(/32 字节/)
  })

  it('模型密钥以密文落库且主密钥不入库', async () => {
    const { database } = await bff()
    const dump = JSON.stringify(database.prepare('SELECT * FROM agent_secrets').all())
    expect(dump).not.toContain('sk-secret-value')
    expect(dump).not.toContain(masterKey)
    database.close()
  })

  it('未配置模型密钥时返回 SECRET_NOT_CONFIGURED 而非泄露细节', async () => {
    const { app, database } = await bff({ withLlm: false })
    const response = await run(app, 's-1', 'hi')
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
    database.close()
  })
})

describe('browser-extension-bff 运行协议', () => {
  it('返回最终文本', async () => {
    stubFinal('已完成')
    const { app, database } = await bff()
    await expect((await run(app, 's-1', '你好')).json()).resolves.toEqual({ type: 'final', output: '已完成' })
    database.close()
  })

  it('远端工具返回 pending_tool_calls 且不在服务端执行', async () => {
    stubToolCall('browser.locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const payload = (await (await run(app, 's-1', '定位打招呼按钮')).json()) as { type: string; calls: Array<{ toolName: string; callId: string }> }
    expect(payload.type).toBe('pending_tool_calls')
    expect(payload.calls[0]).toMatchObject({ toolName: 'browser.locate_element' })
    database.close()
  })

  it('工具结果回填后继续推进模型', async () => {
    stubToolCall('browser.locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    const callId = pending.calls[0]?.callId
    stubFinal('按钮在 (100, 200)')
    const response = await app.request(`/v1/agent/sessions/s-1/tool-results/${callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: true, x: 100, y: 200 } }),
    })
    await expect(response.json()).resolves.toEqual({ type: 'final', output: '按钮在 (100, 200)' })
    database.close()
  })

  it('工具输出不符合 Schema 时回填被拒', async () => {
    stubToolCall('browser.locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    const response = await app.request(`/v1/agent/sessions/s-1/tool-results/${pending.calls[0]?.callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: 'yes' } }),
    })
    await expect(response.json()).resolves.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' })
    database.close()
  })

  it('跨 session 回填被拒绝', async () => {
    stubToolCall('browser.locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    const response = await app.request(`/v1/agent/sessions/s-other/tool-results/${pending.calls[0]?.callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: true } }),
    })
    await expect(response.json()).resolves.toMatchObject({ code: 'PENDING_CALL_NOT_FOUND' })
    database.close()
  })

  it('会话按已认证主体隔离命名空间', async () => {
    stubFinal('ok')
    const { app, runtime, database } = await bff()
    await run(app, 's-1', '你好')
    // 主体前缀绑定：扩展传的 s-1 实际落在 browser-extension:s-1 下。
    await expect(runtime.sessions.load('browser-extension:s-1')).resolves.not.toHaveLength(0)
    await expect(runtime.sessions.load('s-1')).resolves.toHaveLength(0)
    database.close()
  })

  it('把工具清单作为 tools 字段发给模型', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, database } = await bff()
    await run(app, 's-1', '你好')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { tools?: Array<{ function: { name: string } }> }
    expect(body.tools?.map((tool) => tool.function.name)).toEqual(browserToolDefinitions.map((tool) => tool.name))
    database.close()
  })
})

describe('browser-extension-bff 日志与错误红线', () => {
  it('错误响应只含 code/requestId/message 且不回显 Prompt 与密钥', async () => {
    const { app, database } = await bff({ withLlm: false })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ input: 'prompt-secret-content', context: { apiKey: 'sk-leaked-value' } }),
    })
    const text = await response.text()
    expect(text).not.toContain('prompt-secret-content')
    expect(text).not.toContain('sk-leaked-value')
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['code', 'message', 'requestId'])
    database.close()
  })
})

describe('浏览器工具定义', () => {
  it('全部工具声明为 remote，不在服务端执行', () => {
    expect(browserToolDefinitions.every((tool) => tool.execution === 'remote')).toBe(true)
    expect(browserToolDefinitions.every((tool) => tool.execute === undefined)).toBe(true)
  })

  it('覆盖闭环所需的 8 个工具', () => {
    expect(browserToolDefinitions.map((tool) => tool.name)).toEqual([
      'browser.read_page',
      'browser.locate_element',
      'browser.click',
      'browser.input_text',
      'browser.press_key',
      'browser.scroll',
      'browser.verify',
      'browser.screenshot',
    ])
  })

  it('每个工具都有供模型理解用途的说明', () => {
    expect(browserToolDefinitions.every((tool) => (tool.description ?? '').length > 0)).toBe(true)
  })
})
