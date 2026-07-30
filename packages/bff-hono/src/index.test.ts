import { describe, expect, it } from 'vitest'

import { createAgentBff } from './index.js'

describe('Agent BFF', () => {
  it('未鉴权请求返回 401', async () => {
    const app = createAgentBff({ authenticate: async () => null, run: async () => ({ type: 'final', output: 'unused' }) })
    const response = await app.request('/v1/agent/sessions/s-1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi', context: {} }) })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
