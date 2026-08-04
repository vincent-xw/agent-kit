import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSqliteAgentRuntime, createSqliteSecretProvider, createSqliteSessionStore } from './index.js'

const validMasterKey = 'A'.repeat(43)
const otherMasterKey = 'B'.repeat(43)

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('SQLite runtime 拒绝非 32 字节主密钥', () => {
    const database = new DatabaseSync(':memory:')
    expect(() => createSqliteAgentRuntime({ database, masterKey: 'short-key' })).toThrowError(/32 字节/)
  })

  it('key_version 与主密钥不匹配时拒绝解密', async () => {
    const database = new DatabaseSync(':memory:')
    const provider = createSqliteSecretProvider({ database, masterKey: validMasterKey })
    await provider.put({ apiKey: 'sk-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })

    const other = createSqliteSecretProvider({ database, masterKey: otherMasterKey })
    await expect(other.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
  })

  it('runtime harness 使用 SQLite 密钥完成文本输出且密文不落明文', async () => {
    const database = new DatabaseSync(':memory:')
    const runtime = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3 })
    await runtime.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))

    await expect(runtime.harness.run({ sessionId: 's-1', input: 'hi', context: {} })).resolves.toEqual({ type: 'final', output: '你好' })
    const rows = database.prepare('SELECT ciphertext FROM agent_secrets').all() as Array<{ ciphertext: string }>
    expect(JSON.stringify(rows)).not.toContain('sk-test-value')
  })

})
