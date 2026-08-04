import { AgentKitError } from './errors.js'
import type { LlmResult, SessionMessage } from './contracts.js'

/** LlmClient 配置：密钥、Base URL 与模型名来自受信任来源。 */
export interface LlmClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** 请求超时毫秒数，默认 30 秒。 */
  timeoutMs?: number
}

/** 一次补全请求：input 为最新用户输入，messages 为会话历史，systemPrompt 可选。 */
export interface LlmClientRequest {
  input?: string
  context: Record<string, unknown>
  messages: SessionMessage[]
  systemPrompt?: string
}

/** OpenAI Chat Completions 兼容客户端接口。 */
export interface LlmClient {
  complete(request: LlmClientRequest): Promise<LlmResult>
}

/** 把会话消息转换为 OpenAI 协议消息；工具结果与用户输入统一序列化为字符串。 */
function toOpenAiMessages(request: LlmClientRequest): Array<{ role: 'system' | 'user' | 'tool'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'tool'; content: string }> = []
  if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt })
  if (Object.keys(request.context).length > 0) {
    messages.push({ role: 'system', content: `context: ${JSON.stringify(request.context)}` })
  }
  for (const message of request.messages) {
    messages.push({
      role: message.role === 'tool' ? 'tool' : 'user',
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    })
  }
  if (request.input) messages.push({ role: 'user', content: request.input })
  return messages
}

/** 从 OpenAI 响应中提取最终文本或首个工具调用；结构不合法时返回 null。 */
function extractResult(payload: unknown): LlmResult | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as { choices?: unknown }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return null
  const message = (record.choices[0] as { message?: { content?: unknown; tool_calls?: unknown } } | undefined)?.message
  if (!message) return null
  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const call = toolCalls[0] as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const functionCall = call.function
    if (!functionCall || typeof functionCall.name !== 'string') return null
    let input: unknown = {}
    if (typeof functionCall.arguments === 'string' && functionCall.arguments.length > 0) {
      try {
        input = JSON.parse(functionCall.arguments)
      } catch {
        return null
      }
    }
    const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : `call-${Math.random().toString(36).slice(2)}`
    return { type: 'tool_call', callId, toolName: functionCall.name, input }
  }
  return { type: 'final', output: typeof message.content === 'string' ? message.content : '' }
}

/** 创建 OpenAI Chat Completions 兼容 HTTP 客户端，统一错误标准化为 AgentKitError。 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? 30_000
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(request) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        let response: { ok: boolean; status: number; json(): Promise<unknown> }
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: toOpenAiMessages(request),
            }),
            signal: controller.signal,
          })
        } catch (error) {
          // 网络失败、DNS、超时与 abort 均归一化为稳定的 LLM_RESPONSE_INVALID。
          throw new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 请求失败', { cause: error })
        }
        if (!response.ok) {
          throw new AgentKitError('LLM_RESPONSE_INVALID', `LLM 返回 HTTP ${response.status}`)
        }
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          throw new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应不是有效 JSON')
        }
        const result = extractResult(payload)
        if (!result) throw new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应缺少合法 choices 或 tool_calls')
        return result
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
