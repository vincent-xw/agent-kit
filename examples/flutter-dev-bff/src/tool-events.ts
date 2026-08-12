import type { LlmTraceEvent, ToolDefinition } from '@agent-kit/core'
import type { EventBus } from './services/event-bus.js'

/** 序列化并截断，用于事件载荷。mobile_snapshot 返回整棵无障碍树，不截断会拖垮浏览器。 */
export function truncate(value: unknown, limit = 2000): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[truncated, ${text.length} chars]`
}

export function instrumentTools(definitions: ToolDefinition[], bus: EventBus): ToolDefinition[] {
  return definitions.map((definition) => {
    const original = definition.execute
    if (!original) return definition
    return {
      ...definition,
      execute: async (input, context) => {
        bus.emit({ type: 'tool_start', name: definition.name, input: truncate(input) })
        const startedAt = Date.now()
        try {
          const output = await original(input, context)
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: true,
            durationMs: Date.now() - startedAt,
            output: truncate(output),
          })
          return output
        } catch (error) {
          bus.emit({
            type: 'tool_end',
            name: definition.name,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          })
          // 必须原样抛出：harness 会捕获工具错误并转成 ok:false 结果回传给模型，
          // 改变异常类型会干扰该机制。
          throw error
        }
      },
    }
  })
}

/**
 * 把 LlmTraceEvent 转成只含摘要的事件推给 bus。
 *
 * 绝不推 body 与 responseBody：前者含 system prompt 全文与全部会话消息，
 * 后者是模型原文，二者都属于 AuditLogger 契约明确禁止记录的内容。
 */
export function llmTraceToBus(bus: EventBus): (event: LlmTraceEvent) => void {
  return (event) => {
    if (event.phase === 'request') {
      const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
      bus.emit({
        type: 'llm_request',
        requestId: event.requestId,
        model: typeof body.model === 'string' ? body.model : 'unknown',
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      })
      return
    }
    if (event.phase === 'response') {
      const choices = (event.responseBody as { choices?: unknown } | undefined)?.choices
      const first = Array.isArray(choices)
        ? (choices[0] as { finish_reason?: unknown; message?: { tool_calls?: unknown } } | undefined)
        : undefined
      bus.emit({
        type: 'llm_response',
        requestId: event.requestId,
        durationMs: event.durationMs,
        finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'unknown',
        toolCallCount: Array.isArray(first?.message?.tool_calls) ? first.message.tool_calls.length : 0,
      })
      return
    }
    bus.emit({
      type: 'llm_error',
      requestId: event.requestId,
      durationMs: event.durationMs,
      error: event.error instanceof Error ? event.error.message : String(event.error),
    })
  }
}
