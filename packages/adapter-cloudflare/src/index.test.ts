import { describe, expect, it } from 'vitest'

import { createCloudflareSecretProvider, createD1SessionStore } from './index.js'

describe('Cloudflare SecretProvider', () => {
  it('缺少显式 API Key Binding 时拒绝读取配置', async () => {
    const provider = createCloudflareSecretProvider(
      { LLM_API_KEY: '', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'test-model' },
      { apiKeyBinding: 'LLM_API_KEY', baseUrlBinding: 'LLM_BASE_URL', modelBinding: 'LLM_MODEL' },
    )

    await expect(provider.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
  })

  it('D1 session store 按 sessionId 保存并读取消息', async () => {
    const records = new Map<string, string>()
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: string[]) => ({
          run: async () => { records.set(values[0]!, values[1]!) },
          first: async () => sql.startsWith('SELECT') ? { messages: records.get(values[0]!) } : null,
        }),
      }),
    }
    const store = createD1SessionStore(database)
    await store.save('s-1', [{ role: 'user', content: '你好' }])
    await expect(store.load('s-1')).resolves.toEqual([{ role: 'user', content: '你好' }])
  })
})
