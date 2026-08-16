import { describe, expect, it, vi } from 'vitest'
import { VisionClient } from './vision-client.js'

const config = { apiKey: 'sk-test', baseUrl: 'http://localhost:11434/v1', model: 'qwen-vl' }

describe('VisionClient', () => {
  it('发送 base64 图片并返回文字描述', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '屏幕上有一个登录按钮和两个输入框' } }] }),
    }))
    const client = new VisionClient(config, { fetchImpl: fetchMock as unknown as typeof fetch })
    const result = await client.analyze(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    )
    expect(result).toBe('屏幕上有一个登录按钮和两个输入框')
  })

  it('请求体包含 model、messages 和 max_tokens', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }))
    const client = new VisionClient(config, { fetchImpl: fetchMock as unknown as typeof fetch })
    await client.analyze('dGVzdA==')
    const call = fetchMock.mock.calls[0]! as unknown as [string, { body: string }]
    const body = JSON.parse(call[1]!.body)
    expect(body.model).toBe('qwen-vl')
    expect(body.max_tokens).toBe(500)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content[0].type).toBe('text')
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('HTTP 非 2xx 抛出错误', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
      json: async () => ({ error: 'unauthorized' }),
    }))
    const client = new VisionClient(config, { fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(client.analyze('x')).rejects.toThrow(/401|unauthorized/)
  })

  it('网络错误抛出', async () => {
    const client = new VisionClient(config, {
      fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch,
    })
    await expect(client.analyze('x')).rejects.toThrow(/connect ECONNREFUSED/)
  })
})