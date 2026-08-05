import { AgentKitError } from './errors.js'
import type { LlmResult, SessionMessage, ToolCall, ToolSchema } from './contracts.js'

/** LlmClient 配置：密钥、Base URL 与模型名来自受信任来源。 */
export interface LlmClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** 请求超时毫秒数，默认 30 秒。 */
  timeoutMs?: number
}

/** 一次补全请求：input 为最新用户输入，messages 为会话历史，tools 为可调用工具声明。 */
export interface LlmClientRequest {
  input?: string
  context: Record<string, unknown>
  messages: SessionMessage[]
  systemPrompt?: string
  /** 已注册工具的 JSON Schema 声明；为空或省略时不发送 tools 字段。 */
  tools?: ToolSchema[]
  /** 期望模型返回 JSON 对象；由 prompt 的输出协议声明驱动。 */
  responseFormatJson?: boolean
}

/** OpenAI Chat Completions 兼容客户端接口。 */
export interface LlmClient {
  complete(request: LlmClientRequest): Promise<LlmResult>
}

/** OpenAI 协议消息。tool 角色必须带 tool_call_id，否则真实端点返回 400。 */
type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string }

/** 统一序列化消息内容：字符串原样，其余 JSON 化。 */
function serialize(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** 把会话消息转换为 OpenAI 协议消息。 */
function toOpenAiMessages(request: LlmClientRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = []
  if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt })
  if (Object.keys(request.context).length > 0) {
    messages.push({ role: 'system', content: `context: ${JSON.stringify(request.context)}` })
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const content = message.content === null || message.content === undefined ? null : serialize(message.content)
      messages.push({
        role: 'assistant',
        content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.callId,
                type: 'function' as const,
                function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      })
      continue
    }
    if (message.role === 'tool') {
      messages.push({ role: 'tool', content: serialize(message.content), tool_call_id: message.callId })
      continue
    }
    messages.push({ role: 'user', content: serialize(message.content) })
  }
  if (request.input) messages.push({ role: 'user', content: request.input })
  return messages
}

/** 解析单个 tool_call 条目；结构不合法时返回 null。 */
function parseToolCall(raw: unknown, index: number): ToolCall | null {
  const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
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
  // 少数端点不回 id；用索引兜一个稳定值，避免多调用共用同一 callId。
  const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : `call-${index}-${Math.random().toString(36).slice(2)}`
  return { callId, toolName: functionCall.name, input }
}

/** 从 OpenAI 响应中提取最终文本或本轮全部工具调用；结构不合法时返回 null。 */
function extractResult(payload: unknown): LlmResult | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as { choices?: unknown }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return null
  const message = (record.choices[0] as { message?: { content?: unknown; tool_calls?: unknown } } | undefined)?.message
  if (!message) return null
  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const calls: ToolCall[] = []
    for (const [index, raw] of toolCalls.entries()) {
      const parsed = parseToolCall(raw, index)
      if (!parsed) return null
      calls.push(parsed)
    }
    return { type: 'tool_calls', calls }
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
              // 不发 tools 模型就不知道有哪些工具可调，工具调用链路整体不可达。
              ...(request.tools && request.tools.length > 0
                ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }
                : {}),
              ...(request.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
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
