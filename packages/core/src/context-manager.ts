import type { SessionMessage } from './contracts.js'

/** 会话上下文管理器：按 session 保存消息并执行窗口裁剪。 */
export interface ContextManager {
  load(sessionId: string): SessionMessage[]
  save(sessionId: string, messages: SessionMessage[]): void
  append(sessionId: string, message: SessionMessage): void
  /** 返回窗口裁剪产生的摘要文本；未发生过裁剪时返回 undefined。 */
  getSummary(sessionId: string): string | undefined
}

/**
 * 内存实现：超过 maxMessages 时丢弃最旧消息并记录裁剪摘要。
 * 摘要只描述被裁剪的数量，不包含业务上下文与敏感内容。
 */
export function createContextManager(options: { maxMessages: number }): ContextManager {
  const sessions = new Map<string, SessionMessage[]>()
  const summaries = new Map<string, string>()

  function trim(sessionId: string, messages: SessionMessage[]): SessionMessage[] {
    if (messages.length <= options.maxMessages) return messages
    const dropped = messages.length - options.maxMessages
    summaries.set(sessionId, `已裁剪 ${dropped} 条历史消息`)
    return messages.slice(-options.maxMessages)
  }

  return {
    load(sessionId) {
      return sessions.get(sessionId) ?? []
    },
    save(sessionId, messages) {
      sessions.set(sessionId, trim(sessionId, messages))
    },
    append(sessionId, message) {
      const next = [...(sessions.get(sessionId) ?? []), message]
      sessions.set(sessionId, trim(sessionId, next))
    },
    getSummary(sessionId) {
      return summaries.get(sessionId)
    },
  }
}
