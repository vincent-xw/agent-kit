import { AgentKitError } from '@agent-kit/core'
import type { AgentHarness } from '@agent-kit/core'
import { Hono } from 'hono'

/** 创建不持有密钥的 HTTP 边界；密钥、会话与 harness 均由 BFF 服务端注入。 */
export function createAgentBff(options: {
  harness: AgentHarness
  authenticate: (request: Request) => Promise<{ subject: string } | null>
}) {
  const app = new Hono()

  app.post('/v1/agent/sessions/:sessionId/run', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      const body = await context.req.json<{ input?: unknown; context?: unknown }>()
      if (typeof body.input !== 'string' || !body.input.trim() || !body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }
      // 把已认证主体绑定到 session namespace，防止跨用户读取同一 sessionId 的上下文。
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.run({
        sessionId: scopedSessionId,
        input: body.input,
        context: body.context as Record<string, unknown>,
      })
      return context.json(result)
    } catch (error) {
      return context.json(toErrorPayload(error, requestId), 500)
    }
  })

  app.post('/v1/agent/sessions/:sessionId/tool-results/:callId', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      const body = await context.req.json<{ output?: unknown }>()
      if (!Object.prototype.hasOwnProperty.call(body, 'output')) {
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '缺少工具输出' }, 400)
      }
      // 远端工具结果只允许回填当前用户、当前 session 尚未完成的 callId。
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.resume({
        sessionId: scopedSessionId,
        callId: context.req.param('callId'),
        output: body.output,
      })
      return context.json(result)
    } catch (error) {
      return context.json(toErrorPayload(error, requestId), 500)
    }
  })

  return app
}

/** 把任意错误归一化为 { code, requestId, message }，绝不回显密钥、Prompt 正文或业务上下文。 */
function toErrorPayload(error: unknown, requestId: string): { code: string; requestId: string; message: string } {
  if (error instanceof AgentKitError) {
    return { code: error.code, requestId, message: error.message }
  }
  return { code: 'INTERNAL', requestId, message: '服务内部错误' }
}
