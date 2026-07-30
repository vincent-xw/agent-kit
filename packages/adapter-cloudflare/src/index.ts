import { AgentKitError } from '@agent-kit/core'

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
