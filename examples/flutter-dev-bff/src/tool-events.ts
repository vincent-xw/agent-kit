import type { ToolDefinition } from '@agent-kit/core'
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
