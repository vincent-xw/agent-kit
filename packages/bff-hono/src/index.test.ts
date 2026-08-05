import { AgentKitError } from '@agent-kit/core'
import type { AgentHarness } from '@agent-kit/core'
import { describe, expect, it } from 'vitest'

import { createAgentBff } from './index.js'

describe('Agent BFF', () => {
  it('未鉴权请求返回 401', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => null })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('鉴权通过后返回远端工具挂起协议', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => ({ subject: 'user-1' }) })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '读取页面', context: {} }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ type: 'pending_tool_calls', calls: [{ toolName: 'browser.read_page' }] })
  })

  it('远端工具结果回填后继续 harness', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => ({ subject: 'user-1' }) })
    const runResponse = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '读取页面', context: {} }),
    })
    const pending = (await runResponse.json()) as { calls: Array<{ callId: string }> }
    const response = await app.request(`/v1/agent/sessions/s-1/tool-results/${pending.calls[0]?.callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { title: '首页' } }),
    })
    await expect(response.json()).resolves.toEqual({ type: 'final', output: '页面标题：首页' })
  })

  it('跨 session 的 callId 回填被拒绝且错误响应含 requestId', async () => {
    const app = createAgentBff({ harness: createHarness(), authenticate: async () => ({ subject: 'user-1' }) })
    await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '读取页面', context: {} }),
    })
    const response = await app.request('/v1/agent/sessions/other/tool-results/call-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { title: '首页' } }),
    })
    expect(response.status).toBe(500)
    const payload = (await response.json()) as { code: string; requestId: string; message: string }
    expect(payload.code).toBe('PENDING_CALL_NOT_FOUND')
    expect(payload.requestId).toMatch(/^req-/)
  })

  it('subject 绑定到 session namespace 防止跨用户读取', async () => {
    const received: string[] = []
    const app = createAgentBff({ harness: createHarness({ onRun: (sessionId) => received.push(sessionId) }), authenticate: async () => ({ subject: 'user-1' }) })
    await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '读取页面', context: {} }),
    })
    expect(received).toEqual(['user-1:s-1'])
  })

  it('错误响应不包含 Prompt 正文等敏感字段', async () => {
    const app = createAgentBff({ harness: createHarness({ failWithSecret: true }), authenticate: async () => ({ subject: 'user-1' }) })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'prompt-secret-content', context: { apiKey: 'sk-leaked-value' } }),
    })
    const text = await response.text()
    expect(text).not.toContain('prompt-secret-content')
    expect(text).not.toContain('sk-leaked-value')
  })
})

/** 纯内存 fake harness：先远端挂起，回填后返回最终文本，用于测试 BFF 边界行为。 */
function createHarness(options?: { onRun?: (sessionId: string) => void; failWithSecret?: boolean }): AgentHarness {
  const pending = new Map<string, string>()
  return {
    async run(request) {
      options?.onRun?.(request.sessionId)
      if (options?.failWithSecret) throw new AgentKitError('SECRET_NOT_CONFIGURED', '密钥未配置')
      if (request.input === '读取页面') {
        pending.set('call-1', request.sessionId)
        return { type: 'pending_tool_calls', calls: [{ callId: 'call-1', toolName: 'browser.read_page', input: {} }] }
      }
      return { type: 'final', output: 'ok' }
    },
    async resume(request) {
      if (pending.get(request.callId) !== request.sessionId) {
        throw new AgentKitError('PENDING_CALL_NOT_FOUND', `未找到可回填的工具调用：${request.callId}`)
      }
      pending.delete(request.callId)
      return { type: 'final', output: '页面标题：首页' }
    },
  }
}
