import { AgentKitError, createAgentHarness, createLlmClient, createToolRegistry } from '@agent-kit/core'
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

/** D1 只持久化受控的 session 消息 JSON 与更新时间，不保存 LLM Secret。 */
export function createD1SessionStore(database: { prepare(sql: string): { bind(...values: string[]): { run(): Promise<unknown>; first(): Promise<{ messages?: string | undefined } | null> } } }) {
  return {
    async save(sessionId: string, messages: SessionMessage[]) {
      await database
        .prepare('INSERT OR REPLACE INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
        .bind(sessionId, JSON.stringify(messages), new Date().toISOString())
        .run()
    },
    async load(sessionId: string): Promise<SessionMessage[]> {
      const row = await database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').bind(sessionId).first()
      if (!row?.messages) return []
      try { return JSON.parse(row.messages) as SessionMessage[] } catch { return [] }
    },
  }
}

/** 组装 core 所需依赖：Worker Binding 密钥、D1 会话存储、工具注册表与 harness。 */
export function createCloudflareAgentRuntime(
  env: Record<string, unknown>,
  options: {
    apiKeyBinding: string
    baseUrlBinding: string
    modelBinding: string
    database: Parameters<typeof createD1SessionStore>[0]
    maxSteps?: number
  },
) {
  const secrets = createCloudflareSecretProvider(env, {
    apiKeyBinding: options.apiKeyBinding,
    baseUrlBinding: options.baseUrlBinding,
    modelBinding: options.modelBinding,
  })
  const sessions = createD1SessionStore(options.database)
  const tools = createToolRegistry()
  const harness = createAgentHarness({
    // 每次补全前从 Worker Binding 读取当前配置，未配置时由 SecretProvider 抛稳定错误码。
    llm: { complete: async (request) => createLlmClient(await secrets.get()).complete(request) },
    sessions,
    tools,
    maxSteps: options.maxSteps ?? 10,
  })
  return { secrets, sessions, tools, harness }
}
