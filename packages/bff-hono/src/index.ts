import { Hono } from 'hono'

/** 创建不持有密钥的 HTTP 边界；密钥和 harness 均由 BFF 服务端注入。 */
export function createAgentBff(options: {
  authenticate: (request: Request) => Promise<{ subject: string } | null>
  run: (input: { sessionId: string; input: string; context: Record<string, unknown>; subject: string }) => Promise<Record<string, unknown>>
  resume: (input: { sessionId: string; callId: string; output: unknown; subject: string }) => Promise<Record<string, unknown>>
}) {
  const app = new Hono()
  app.post('/v1/agent/sessions/:sessionId/run', async (context) => {
    const identity = await options.authenticate(context.req.raw)
    if (!identity) return context.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)
    const body = await context.req.json<{ input?: unknown; context?: unknown }>()
    if (typeof body.input !== 'string' || !body.input.trim() || !body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
      return context.json({ code: 'REQUEST_INVALID', message: '请求参数不合法' }, 400)
    }
    // 将用户身份传入执行器，供调用方按主体隔离 session。
    const result = await options.run({ sessionId: context.req.param('sessionId'), input: body.input, context: body.context as Record<string, unknown>, subject: identity.subject })
    return context.json(result)
  })
  app.post('/v1/agent/sessions/:sessionId/tool-results/:callId', async (context) => {
    const identity = await options.authenticate(context.req.raw)
    if (!identity) return context.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)
    const body = await context.req.json<{ output?: unknown }>()
    if (!Object.prototype.hasOwnProperty.call(body, 'output')) return context.json({ code: 'REQUEST_INVALID', message: '缺少工具输出' }, 400)
    return context.json(await options.resume({ sessionId: context.req.param('sessionId'), callId: context.req.param('callId'), output: body.output, subject: identity.subject }))
  })
  return app
}
