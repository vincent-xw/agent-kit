import { describe, expect, it } from 'vitest'

import { createCloudflareSecretProvider } from './index.js'

describe('Cloudflare SecretProvider', () => {
  it('缺少显式 API Key Binding 时拒绝读取配置', async () => {
    const provider = createCloudflareSecretProvider(
      { LLM_API_KEY: '', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'test-model' },
      { apiKeyBinding: 'LLM_API_KEY', baseUrlBinding: 'LLM_BASE_URL', modelBinding: 'LLM_MODEL' },
    )

    await expect(provider.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
  })
})
