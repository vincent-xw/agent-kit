import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLlmClient } from './index.js'

const baseConfig = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LlmClient', () => {
  it('解析文本输出为 final', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: '你好' })
  })

  it('解析 tool_calls 为 tool_call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'weather.read', arguments: '{"city":"上海"}' } }] } }] }),
    })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'tool_call', callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } })
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
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: { city: '上海' }, messages: [{ role: 'user', content: '你好' }], systemPrompt: '你是助手' })
    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [, init] = firstCall as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(body.messages[1]).toEqual({ role: 'system', content: 'context: {"city":"上海"}' })
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })
})
