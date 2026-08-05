import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLlmClient } from './index.js'

const baseConfig = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

/** 读取被 stub 的 fetch 第一次调用的请求体。 */
function bodyOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const firstCall = fetchMock.mock.calls[0]
  expect(firstCall).toBeDefined()
  const [, init] = firstCall as unknown as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** 构造一个返回固定文本的 fetch stub。 */
function okFetch(payload: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => payload }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LlmClient', () => {
  it('解析文本输出为 final', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: '你好' })
  })

  it('解析单个 tool_calls 为复数结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'weather.read', arguments: '{"city":"上海"}' } }] } }] }),
    })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({
      type: 'tool_calls',
      calls: [{ callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }],
    })
  })

  it('解析一轮内的多个 tool_calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'c1', function: { name: 'a.run', arguments: '{}' } },
                { id: 'c2', function: { name: 'b.run', arguments: '{"x":1}' } },
              ],
            },
          },
        ],
      }),
    })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({
      type: 'tool_calls',
      calls: [
        { callId: 'c1', toolName: 'a.run', input: {} },
        { callId: 'c2', toolName: 'b.run', input: { x: 1 } },
      ],
    })
  })

  it('HTTP 非 2xx 返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('响应不是有效 JSON 返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('请求超时返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const client = createLlmClient({ ...baseConfig, timeoutMs: 50 })
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('请求携带 Bearer 密钥并构造 OpenAI 协议消息', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: { city: '上海' }, messages: [{ role: 'user', content: '你好' }], systemPrompt: '你是助手' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(body.messages[1]).toEqual({ role: 'system', content: 'context: {"city":"上海"}' })
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('携带 tools 声明时请求体包含 tools 字段', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      input: 'hi',
      context: {},
      messages: [],
      tools: [{ name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } }],
    })
    expect(bodyOf(fetchMock).tools).toEqual([
      { type: 'function', function: { name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } } },
    ])
  })

  it('tools 为空数组时不发送 tools 字段', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: {}, messages: [], tools: [] })
    expect(bodyOf(fetchMock)).not.toHaveProperty('tools')
  })

  it('tool 消息携带 tool_call_id', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      context: {},
      messages: [{ role: 'tool', content: { temperature: 26 }, callId: 'call-9' }],
    })
    const body = bodyOf(fetchMock) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({ role: 'tool', content: '{"temperature":26}', tool_call_id: 'call-9' })
  })

  it('assistant 消息携带 tool_calls 并回传原 callId', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      context: {},
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }] },
        { role: 'tool', content: { temperature: 26 }, callId: 'call-1' },
      ],
    })
    const body = bodyOf(fetchMock) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather.read', arguments: '{"city":"上海"}' } }],
    })
    expect(body.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
  })

  it('声明 JSON 输出协议时请求体带 response_format', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: {}, messages: [], responseFormatJson: true })
    expect(bodyOf(fetchMock).response_format).toEqual({ type: 'json_object' })
  })
})
