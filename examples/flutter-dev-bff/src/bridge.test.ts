import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFlutterDevBff, startFlutterDevBffServer } from './server.js'

const masterKey = 'A'.repeat(43)
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function startWithScreenshot(): Promise<{ port: number; png: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'flutter-bff-shot-'))
  const png = Buffer.from(PNG_BASE64, 'base64')
  await writeFile(join(dir, 'shot-test1.png'), png)

  const bff = createFlutterDevBff({
    masterKey,
    apiToken: 'token-1',
    flutterProjectPath: '/tmp/flutter-app',
    databasePath: ':memory:',
    screenshotDir: dir,
  })
  await bff.ready
  const { server, port } = await startFlutterDevBffServer((request) => bff.app.fetch(request), 0)
  cleanups.push(() => {
    server.close()
    bff.database.close()
  })
  return { port, png }
}

describe('flutter-dev-bff HTTP 桥接', () => {
  it('截图 PNG 经真实 HTTP 往返后字节完全一致', async () => {
    const { port, png } = await startWithScreenshot()

    const res = await fetch(`http://127.0.0.1:${port}/api/screenshots/shot-test1`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const received = Buffer.from(await res.arrayBuffer())
    expect(received.length).toBe(png.length)
    expect(received.equals(png)).toBe(true)
  })

  it('JSON 路由经真实 HTTP 仍然正常', async () => {
    const { port } = await startWithScreenshot()

    const res = await fetch(`http://127.0.0.1:${port}/v1/agent/sessions/s-1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })

    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })
})
