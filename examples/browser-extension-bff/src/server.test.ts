import { describe, expect, it } from 'vitest'

import { createBrowserExtensionBff } from './server.js'

describe('browser-extension-bff 示例', () => {
  it('可装配且拒绝未鉴权请求', async () => {
    const { app, database } = createBrowserExtensionBff({
      masterKey: 'A'.repeat(43),
      apiToken: 'token-1',
      databasePath: ':memory:',
    })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(response.status).toBe(401)
    database.close()
  })

  it('鉴权通过后调用 harness 协议', async () => {
    const { app, database } = createBrowserExtensionBff({
      masterKey: 'A'.repeat(43),
      apiToken: 'token-1',
      databasePath: ':memory:',
    })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(response.status).toBe(500)
    database.close()
  })
})
