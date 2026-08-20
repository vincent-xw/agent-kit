import { z } from 'zod'
import type { ToolDefinition } from '@agent-kit/core'
import type { AskService } from '../services/ask-service.js'

export interface UserInteractionService {
  ask: AskService
}

export function createUserInteractionToolDefinitions(svc: UserInteractionService): ToolDefinition[] {
  async function awaitAnswer(
    sessionId: string,
    callId: string,
    kind: 'question' | 'approval',
    question: string,
    options: string[],
    select: 'single' | 'multiple',
  ): Promise<{ ok: true; answer: string | string[] } | { ok: false; error: string }> {
    if (callId === '') return { ok: false, error: '缺少 callId' }
    try {
      const answer = await svc.ask.awaitAnswer({ sessionId, callId, kind, question, options, select })
      return { ok: true, answer }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return [
    {
      name: 'ask_user',
      execution: 'server',
      description: '向用户提出一个问题并等待回答。可单选或多选，用户也可用输入框输入其他答案。用于需要用户决策或提供信息的时刻。',
      input: z.object({
        question: z.string(),
        select: z.enum(['single', 'multiple']),
        options: z.array(z.string()).optional(),
      }),
      output: z.object({ ok: z.boolean(), answer: z.union([z.string(), z.array(z.string())]).optional(), error: z.string().optional(), timeout: z.boolean().optional() }),
      timeoutMs: 300_000,
      async execute(raw, context) {
        const { question, select, options = [] } = raw as { question: string; select: 'single' | 'multiple'; options?: string[] }
        if (!question.trim()) return { ok: false, error: 'question 不能为空' }
        if (select === 'multiple' && options.length < 2) return { ok: false, error: '多选至少需要 2 个选项' }
        if (select === 'single' && options.length === 1) return { ok: false, error: '单选需 0 或 2+ 个选项，否则无意义' }
        const ctx = (context ?? {}) as { sessionId?: string; callId?: string }
        const r = await awaitAnswer(ctx.sessionId ?? '', ctx.callId ?? '', 'question', question, options, select)
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, answer: r.answer }
      },
    },
    {
      name: 'user_confirm',
      execution: 'server',
      description: '请用户对一个即将执行的高危操作做允许/拒绝审批。先说明要做什么：action（简明操作）、target（对象，如路径/命令/URL）、message（展示文案）、purpose（审批理由）。',
      input: z.object({
        action: z.string(),
        target: z.string().optional(),
        message: z.string().optional(),
        purpose: z.string().optional(),
      }),
      output: z.object({ decision: z.enum(['allow', 'deny']).optional(), error: z.string().optional() }),
      timeoutMs: 300_000,
      async execute(raw, context) {
        const { action, target, message } = raw as { action: string; target?: string; message?: string }
        const ctx = (context ?? {}) as { sessionId?: string; callId?: string }
        const question = message || `允许${target ? ` ${target}` : ''}${action ? `：${action}` : ''} 吗？`
        const r = await awaitAnswer(ctx.sessionId ?? '', ctx.callId ?? '', 'approval', question, ['允许', '拒绝'], 'single')
        if (!r.ok) return { error: r.error }
        return r.answer === '允许' ? { decision: 'allow' } : { decision: 'deny' }
      },
    },
  ]
}