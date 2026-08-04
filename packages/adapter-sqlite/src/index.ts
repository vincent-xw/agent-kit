import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { AgentKitError, createAgentHarness, createLlmClient, createToolRegistry } from '@agent-kit/core'
import type { LlmSecret, SessionMessage } from '@agent-kit/core'

/** 由主密钥派生短密钥版本标识，轮换后旧密文无法通过版本校验。 */
function deriveKeyVersion(masterKey: string): string {
  return createHash('sha256').update(masterKey, 'utf8').digest('hex').slice(0, 16)
}

/** SQLite 中只保存 AES-GCM 密文与密钥版本；主密钥由 BFF 进程环境提供，不落库。 */
export function createSqliteSecretProvider(options: { database: DatabaseSync; masterKey: string }) {
  const key = Buffer.from(options.masterKey, 'base64url')
  if (key.byteLength !== 32) throw new AgentKitError('SECRET_NOT_CONFIGURED', 'AGENT_KIT_MASTER_KEY 必须是 32 字节 base64url 值')
  const keyVersion = deriveKeyVersion(options.masterKey)
  // 表结构与 src/schema.sql 保持一致；key_version 用于主密钥轮换后拒绝旧密文。
  options.database.exec(`CREATE TABLE IF NOT EXISTS agent_secrets (
    id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_version TEXT NOT NULL
  )`)
  return {
    async put(secret: LlmSecret): Promise<void> {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      options.database
        .prepare('INSERT OR REPLACE INTO agent_secrets (id, ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)')
        .run('default', ciphertext.toString('base64url'), iv.toString('base64url'), tag.toString('base64url'), keyVersion)
    },
    async get(): Promise<LlmSecret> {
      const record = options.database.prepare('SELECT ciphertext, iv, tag, key_version FROM agent_secrets WHERE id = ?').get('default') as
        | { ciphertext?: string; iv?: string; tag?: string; key_version?: string }
        | undefined
      if (!record?.ciphertext || !record.iv || !record.tag || !record.key_version) {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite 中未配置 LLM Secret')
      }
      if (record.key_version !== keyVersion) {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite LLM Secret 的主密钥版本不匹配，请用当前主密钥重新写入')
      }
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
  database.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
  return {
    async save(sessionId: string, messages: SessionMessage[]) {
      database
        .prepare('INSERT OR REPLACE INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
        .run(sessionId, JSON.stringify(messages), new Date().toISOString())
    },
    async load(sessionId: string): Promise<SessionMessage[]> {
      const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(sessionId) as { messages?: string } | undefined
      if (!row?.messages) return []
      try { return JSON.parse(row.messages) as SessionMessage[] } catch { return [] }
    },
  }
}

/** 组装 core 所需依赖：密钥库、会话存储、工具注册表与 harness。 */
export function createSqliteAgentRuntime(options: { database: DatabaseSync; masterKey: string; maxSteps?: number }) {
  const secrets = createSqliteSecretProvider({ database: options.database, masterKey: options.masterKey })
  const sessions = createSqliteSessionStore(options.database)
  const tools = createToolRegistry()
  const harness = createAgentHarness({
    // 每次补全前从 SQLite 读取当前密钥，未配置或版本不匹配时由 SecretProvider 抛稳定错误码。
    llm: { complete: async (request) => createLlmClient(await secrets.get()).complete(request) },
    sessions,
    tools,
    maxSteps: options.maxSteps ?? 10,
  })
  return { secrets, sessions, tools, harness, database: options.database }
}
