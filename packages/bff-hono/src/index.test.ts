import { describe, expect, it } from 'vitest'

import { createAgentBff } from './index.js'

describe('Agent BFF', () => {
  it('未鉴权请求返回 401', async () => {
    const app = createAgentBff({ authenticate: async () => null, run: async () => ({ type: 'final', output: 'unused' }), resume: async () => ({ type: 'final', output: 'unused' }) })
    const response = await app.request('/v1/agent/sessions/s-1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi', context: {} }) })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('仅将已鉴权的远端工具结果回填给 harness', async () => {
    const app = createAgentBff({
      authenticate: async () => ({ subject: 'user-1' }),
      run: async () => ({ type: 'pending_tool_call', callId: 'call-1', toolName: 'browser.read_page', input: {} }),
      resume: async () => ({ type: 'final', output: '页面已读取' }),
    })
    const response = await app.request('/v1/agent/sessions/s-1/tool-results/call-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ output: { title: '首页' } }) })
    await expect(response.json()).resolves.toEqual({ type: 'final', output: '页面已读取' })
  })
})
