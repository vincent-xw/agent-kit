import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { AgentKitError } from '@agent-kit/core'
import type { SessionMessage } from '@agent-kit/core'

type LlmSecret = { apiKey: string; baseUrl: string; model: string }

/** SQLite 中只保存 AES-GCM 密文；主密钥由 BFF 进程环境提供。 */
export function createSqliteSecretProvider(options: { database: DatabaseSync; masterKey: string }) {
  const key = Buffer.from(options.masterKey, 'base64url')
  if (key.byteLength !== 32) throw new AgentKitError('SECRET_NOT_CONFIGURED', 'AGENT_KIT_MASTER_KEY 必须是 32 字节 base64url 值')
  options.database.exec('CREATE TABLE IF NOT EXISTS agent_secrets (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL)')
  return {
    async put(secret: LlmSecret): Promise<void> {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      options.database.prepare('INSERT OR REPLACE INTO agent_secrets (id, ciphertext, iv, tag) VALUES (?, ?, ?, ?)').run('default', ciphertext.toString('base64url'), iv.toString('base64url'), tag.toString('base64url'))
    },
    async get(): Promise<LlmSecret> {
      const record = options.database.prepare('SELECT ciphertext, iv, tag FROM agent_secrets WHERE id = ?').get('default') as { ciphertext?: string; iv?: string; tag?: string } | undefined
      if (!record?.ciphertext || !record.iv || !record.tag) throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite 中未配置 LLM Secret')
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(record.tag, 'base64url'))
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as LlmSecret
      } catch {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite LLM Secret 无法解密')
      }
    },
  }
}

/** SQLite session 表与密钥表分离，避免业务上下文与密钥混存。 */
export function createSqliteSessionStore(database: DatabaseSync) {
  database.exec('CREATE TABLE IF NOT EXISTS agent_sessions (session_id TEXT PRIMARY KEY, messages TEXT NOT NULL)')
  return {
    async save(sessionId: string, messages: SessionMessage[]) {
      database.prepare('INSERT OR REPLACE INTO agent_sessions (session_id, messages) VALUES (?, ?)').run(sessionId, JSON.stringify(messages))
    },
    async load(sessionId: string): Promise<SessionMessage[]> {
      const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(sessionId) as { messages?: string } | undefined
      if (!row?.messages) return []
      try { return JSON.parse(row.messages) as SessionMessage[] } catch { return [] }
    },
  }
}
