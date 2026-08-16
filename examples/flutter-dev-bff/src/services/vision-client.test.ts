import { describe, expect, it, vi } from 'vitest'
import { VisionClient } from './vision-client.js'

const config = { apiKey: 'sk-test', baseUrl: 'http://localhost:11434/v1', model: 'qwen-vl' }

function mockFetch(response: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  })) as unknown as typeof fetch
}

describe('VisionClient', () => {
  it('发送 base64 图片并返回文字描述', async () => {
    const client = new VisionClient(config, {
      fetchImpl: mockFetch({
        choices: [{ message: { content: '屏幕上有一个登录按钮和两个输入框' } }],
      }),
    })
    const result = await client.analyze(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    )
    expect(result).toBe('屏幕上有一个登录按钮和两个输入框')
  })

  it('请求体包含 model、messages 和 max_tokens', async () => {
    const fetch = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    const client = new VisionClient(config, { fetchImpl: fetch })
    await client.analyze('dGVzdA==')
    const call = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1]?.body as string)
    expect(body.model).toBe('qwen-vl')
    expect(body.max_tokens).toBe(500)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content[0].type).toBe('text')
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('HTTP 非 2xx 抛出错误', async () => {
    const client = new VisionClient(config, { fetchImpl: mockFetch({ error: 'unauthorized' }, 401) })
    await expect(client.analyze('x')).rejects.toThrow(/401|unauthorized/)
  })

  it('网络错误抛出', async () => {
    const client = new VisionClient(config, {
      fetchImpl: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      }),
    })
    await expect(client.analyze('x')).rejects.toThrow(/connect ECONNREFUSED/)
  })
})