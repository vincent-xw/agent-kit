import { afterEach, describe, expect, it } from 'vitest'
import { createFlutterDevBff, startFlutterDevBffServer } from './server.js'

const masterKey = 'A'.repeat(43)
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function start() {
  const bff = createFlutterDevBff({
    masterKey,
    apiToken: 'token-1',
    flutterProjectPath: '/tmp/flutter-app',
    databasePath: ':memory:',
  })
  await bff.ready
  const { server, port } = await startFlutterDevBffServer((request) => bff.app.fetch(request), 0)
  cleanups.push(() => {
    server.close()
    bff.database.close()
  })
  return { bff, port }
}

/** 从 SSE 流中读取，直到累积文本包含 marker 或超时。 */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(marker)) return text
    }
  } finally {
    await reader.cancel()
  }
  return text
}

describe('SSE 端点', () => {
  it('无 token 返回 401', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events`)

    expect(res.status).toBe(401)
  })

  it('错误 token 返回 401', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=wrong`)

    expect(res.status).toBe(401)
  })

  it('鉴权通过返回 text/event-stream', async () => {
    const { port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body!.cancel()
  })

  it('bus 上 emit 的事件会推送到已连接客户端', async () => {
    const { bff, port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    // 连接建立后再 emit，验证的是实时推送而非重放
    await new Promise((resolve) => setTimeout(resolve, 300))
    bff.bus.emit({ type: 'tool_start', name: 'mobile_snapshot' })

    const text = await readUntil(res.body!, 'mobile_snapshot')

    expect(text).toContain('event: tool_start')
    expect(text).toContain('mobile_snapshot')
  })

  it('Last-Event-ID 重放断开期间的事件', async () => {
    const { bff, port } = await start()
    bff.bus.emit({ type: 'tool_start', name: 'first' })
    bff.bus.emit({ type: 'tool_start', name: 'second' })

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`, {
      headers: { 'last-event-id': '1' },
    })

    const text = await readUntil(res.body!, 'second')

    expect(text).toContain('second')
    expect(text).not.toContain('first')
  })

  it('工具执行会自动产生事件，无需手动 emit', async () => {
    const { bff, port } = await start()

    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const tool = bff.runtime.tools.get('mobile_devices')
    await tool!.execute!({}, { signal: new AbortController().signal }).catch(() => {})

    const text = await readUntil(res.body!, 'mobile_devices')

    expect(text).toContain('mobile_devices')
  })
})
