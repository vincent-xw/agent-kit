import type { SessionMessage } from '@agent-kit/core'

/** 把会话历史渲染为时序 Markdown 转录。toolOutputLimit 为 0 表示不截断。 */
export function renderSessionMarkdown(title: string, messages: SessionMessage[], toolOutputLimit: number): string {
  const sections: string[] = [`# 会话: ${title}`]
  const outputs = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role === 'tool') outputs.set(message.callId, message.content)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      sections.push(`## 用户\n\n${typeof message.content === 'string' ? message.content : fencedJson(message.content)}`)
    } else if (message.role === 'assistant') {
      if (typeof message.content === 'string' && message.content.trim()) {
        sections.push(`## 助手\n\n${message.content}`)
      }
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          sections.push(toolCallSection(call.toolName, call.input, outputs.get(call.callId), toolOutputLimit))
        }
      }
    }
  }
  return sections.join('\n\n') + '\n'
}

function toolCallSection(toolName: string, input: unknown, output: unknown, toolOutputLimit: number): string {
  const parts = [`## 工具调用: ${toolName}`, '**输入**', fencedJson(input)]
  parts.push('**输出**')
  parts.push(output === undefined ? '（无结果）' : fencedJson(output, toolOutputLimit))
  return parts.join('\n\n')
}

function fencedJson(value: unknown, limit = 0): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = '[unserializable]'
  }
  if (limit > 0 && text.length > limit) {
    text = `${text.slice(0, limit)}…[已截断，共 ${text.length} 字符]`
  }
  return '```json\n' + text + '\n```'
}
