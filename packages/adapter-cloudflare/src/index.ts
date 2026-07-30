import { AgentKitError } from '@agent-kit/core'
import type { SessionMessage } from '@agent-kit/core'

export type CloudflareLlmSecret = { apiKey: string; baseUrl: string; model: string }

/** 从明确命名的 Worker Binding 读取模型配置，禁止探测或回退到其它字段。 */
export function createCloudflareSecretProvider(
  env: Record<string, unknown>,
  bindings: { apiKeyBinding: string; baseUrlBinding: string; modelBinding: string },
) {
  return {
    async get(): Promise<CloudflareLlmSecret> {
      const apiKey = env[bindings.apiKeyBinding]
      const baseUrl = env[bindings.baseUrlBinding]
      const model = env[bindings.modelBinding]
      if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseUrl !== 'string' || !baseUrl.trim() || typeof model !== 'string' || !model.trim()) {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'Cloudflare Worker LLM Secret 未完整配置')
      }
      return { apiKey, baseUrl, model }
    },
  }
}

/** D1 只持久化受控的 session 消息 JSON，不保存 LLM Secret。 */
export function createD1SessionStore(database: { prepare(sql: string): { bind(...values: string[]): { run(): Promise<unknown>; first(): Promise<{ messages?: string | undefined } | null> } } }) {
  return {
    async save(sessionId: string, messages: SessionMessage[]) {
      await database.prepare('INSERT OR REPLACE INTO agent_sessions (session_id, messages) VALUES (?, ?)').bind(sessionId, JSON.stringify(messages)).run()
    },
    async load(sessionId: string): Promise<SessionMessage[]> {
      const row = await database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').bind(sessionId).first()
      if (!row?.messages) return []
      try { return JSON.parse(row.messages) as SessionMessage[] } catch { return [] }
    },
  }
}
