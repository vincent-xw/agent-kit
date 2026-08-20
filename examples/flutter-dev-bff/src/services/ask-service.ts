export interface AskRequest {
  sessionId: string
  callId: string
  kind: 'question' | 'approval'
  question: string
  options: string[]
  select: 'single' | 'multiple'
}

export interface AskService {
  /** 发 ask_user 事件并阻塞，直到 resolve/cancel。 */
  awaitAnswer(req: AskRequest): Promise<string | string[]>
  /** 取消一个待答（agent 侧取消 run 时调用）。 */
  cancel(callId: string): void
  /** 回填答案；校验 session 归属，成功返回 true；不存在/归属不符返回 false。 */
  resolve(sessionId: string, callId: string, answer: string | string[]): boolean
}

interface PendingAsk {
  sessionId: string
  resolve: (v: string | string[]) => void
  reject: (e: Error) => void
}

type Bus = { emit(e: { type: string; [k: string]: unknown }): void }

export function createAskService(bus: Bus): AskService {
  const pending = new Map<string, PendingAsk>()
  return {
    async awaitAnswer(req) {
      bus.emit({
        type: 'ask_user',
        kind: req.kind,
        sessionId: req.sessionId,
        callId: req.callId,
        question: req.question,
        options: req.options,
        select: req.select,
      })
      return new Promise<string | string[]>((resolve, reject) => {
        pending.set(req.callId, { sessionId: req.sessionId, resolve, reject })
      })
    },
    cancel(callId) {
      const p = pending.get(callId)
      if (!p) return
      pending.delete(callId)
      p.reject(new Error('cancelled'))
    },
    resolve(sessionId, callId, answer) {
      const p = pending.get(callId)
      if (!p || p.sessionId !== sessionId) return false
      pending.delete(callId)
      p.resolve(answer)
      return true
    },
  }
}