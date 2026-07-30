import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { createSqliteSecretProvider, createSqliteSessionStore } from './index.js'

describe('SQLite SecretProvider', () => {
  it('只保存加密后的 API Key', async () => {
    const database = new DatabaseSync(':memory:')
    const provider = createSqliteSecretProvider({
      database,
      masterKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })

    await provider.put({ apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
    expect(database.prepare('SELECT ciphertext FROM agent_secrets WHERE id = ?').get('default')).not.toMatchObject({ ciphertext: expect.stringContaining('sk-secret-value') })
    await expect(provider.get()).resolves.toEqual({ apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
  })

  it('SQLite session store 持久化受控消息', async () => {
    const database = new DatabaseSync(':memory:')
    const store = createSqliteSessionStore(database)
    await store.save('s-1', [{ role: 'user', content: '你好' }])
    await expect(store.load('s-1')).resolves.toEqual([{ role: 'user', content: '你好' }])
  })
})
