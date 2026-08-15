import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpClient } from './cdp-client.js'
import type { AdbClient } from '../adb-client.js'

/** 一个可外部控制的假 WebSocket。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  readyState = 0

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, cb: (ev?: { data?: string }) => void) {
    if (type === 'open') this.onopen = cb as () => void
    if (type === 'error') this.onerror = cb as () => void
    if (type === 'message') this.onmessage = cb as (ev: { data: string }) => void
    if (type === 'close') this.onclose = cb as () => void
  }
  removeEventListener() {}
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
  /** 测试用：模拟连接成功 */
  open() { this.readyState = 1; queueMicrotask(() => this.onopen?.()) }
  /** 测试用：回应下一条发送的命令 */
  respond(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) })
  }
}

function mockAdb(sockets: string[] = ['webview_devtools_remote_123']) {
  return {
    listWebViewSockets: vi.fn(async () => sockets),
    forward: vi.fn(async () => {}),
    removeForward: vi.fn(async () => {}),
  } as unknown as AdbClient
}

function mockFetch() {
  return vi.fn(async (url: string | URL | Request) => ({
    ok: true,
    json: async () => {
      const u = String(url)
      if (u.endsWith('/json')) {
        return [{ id: 't1', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/t1' }]
      }
      return {}
    },
  })) as unknown as typeof fetch
}

/** 等待 FakeWebSocket 被创建、open 事件触发、且握手命令已发送。 */
async function connected(): Promise<FakeWebSocket> {
  for (let i = 0; i < 20; i++) {
    const ws = FakeWebSocket.instances[0]
    if (ws) {
      ws.open()
      // 等 open 回调跑完（connect resolve 后会发 Runtime.enable 等）
      await new Promise((r) => setTimeout(r, 10))
      return ws
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('WebSocket 未创建')
}

/** 持续回应 ws 上已发送的命令。返回 stop 函数，测试 await 后必须调用。 */
function autoDrain(
  ws: FakeWebSocket,
  elements: unknown[] | null,
  dpr = 1,
  rect = { x: 0, y: 0, width: 200, height: 80 },
): () => void {
  const seen = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    for (const sent of ws.sent as Array<{ id: number; method: string; params?: { expression?: string } }>) {
      if (seen.has(sent.id)) continue
      seen.add(sent.id)
      const expr = sent.params?.expression ?? ''
      // CDP Runtime.evaluate 的 result 是 { result: { type, value } }，两层 result
      if (sent.method === 'Runtime.evaluate' && expr === 'window.devicePixelRatio') {
        ws.respond(sent.id, { result: { result: { value: dpr } } })
      } else if (sent.method === 'Runtime.evaluate' && expr.includes('document.querySelectorAll')) {
        ws.respond(sent.id, { result: { result: { value: JSON.stringify(elements) } } })
      } else if (sent.method === 'Runtime.evaluate' && expr.includes('getBoundingClientRect')) {
        ws.respond(sent.id, { result: { result: { value: rect } } })
      } else {
        ws.respond(sent.id, {})
      }
    }
    timer = setTimeout(tick, 5)
  }
  tick()
  return () => { if (timer) clearTimeout(timer) }
}

describe('CdpClient', () => {
  beforeEach(() => { FakeWebSocket.instances = [] })

  it('没有可调试 WebView 时 isAvailable 为 false', async () => {
    const cdp = new CdpClient(mockAdb([]), { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u) })
    expect(await cdp.isAvailable()).toBe(false)
  })

  it('发现 socket 后 forward、请求 /json、连接 page target', async () => {
    const adb = mockAdb()
    const cdp = new CdpClient(adb, { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9400 })
    const availPromise = cdp.isAvailable()
    const ws = await connected()
    const stop = autoDrain(ws, null)
    expect(await availPromise).toBe(true)
    stop()
    expect(adb.forward).toHaveBeenCalledWith(expect.any(Number), 'localabstract:webview_devtools_remote_123')
  })

  it('snapshot 发送扫描 JS 并转换为节点', async () => {
    const cdp = new CdpClient(mockAdb(), { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9401 })
    const elements = [{ tag: 'button', text: 'H5登录', rect: { x: 10, y: 20, width: 100, height: 40 }, clickable: true, editable: false, scrollable: false, enabled: true, selector: '#h5-submit' }]
    const snapPromise = cdp.snapshot()
    const ws = await connected()
    const stop = autoDrain(ws, elements, 2)
    const snap = await snapPromise
    stop()
    expect(snap.packageName).toBe('webview')
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.text).toBe('H5登录')
    expect(snap.nodes[0]!.bounds.left).toBe(20)
  })

  it('tap 在节点 bounds 中心派发 pressed/released', async () => {
    const cdp = new CdpClient(mockAdb(), { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9402 })
    const elements = [{ tag: 'button', text: 'x', rect: { x: 0, y: 0, width: 200, height: 80 }, clickable: true, editable: false, scrollable: false, enabled: true, selector: '#b' }]
    const snapPromise = cdp.snapshot()
    const ws = await connected()
    const stop = autoDrain(ws, elements, 1)
    await snapPromise

    await cdp.tap(1)
    stop()
    const mouseEvents = ws.sent.filter((m) => (m as { method: string }).method === 'Input.dispatchMouseEvent')
    expect(mouseEvents).toHaveLength(2)
    expect((mouseEvents[0] as { params: { type: string; x: number; y: number } }).params).toMatchObject({ type: 'mousePressed', x: 100, y: 40 })
    expect((mouseEvents[1] as { params: { type: string } }).params.type).toBe('mouseReleased')
  })

  it('setText 聚焦清空后 insertText', async () => {
    const cdp = new CdpClient(mockAdb(), { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9403 })
    const elements = [{ tag: 'input', id: 'h5-user', rect: { x: 0, y: 0, width: 100, height: 40 }, clickable: true, editable: true, scrollable: false, enabled: true, selector: '#h5-user' }]
    const snapPromise = cdp.snapshot()
    const ws = await connected()
    const stop = autoDrain(ws, elements, 1)
    await snapPromise

    await cdp.setText(1, '杭州')
    stop()
    const insert = ws.sent.find((m) => (m as { method: string }).method === 'Input.insertText')
    expect(insert).toBeTruthy()
    expect((insert as { params: { text: string } }).params.text).toBe('杭州')
  })

  it('ref 失效时报错', async () => {
    const cdp = new CdpClient(mockAdb(), { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9405 })
    const p = cdp.snapshot()
    const ws = await connected()
    const stop = autoDrain(ws, [])
    await p
    await expect(cdp.tap(99)).rejects.toThrow(/过期/)
    stop()
  })

  it('dispose 移除 forward', async () => {
    const adb = mockAdb()
    const cdp = new CdpClient(adb, { fetchImpl: mockFetch(), wsFactory: (u) => new FakeWebSocket(u), basePort: 9404 })
    const p = cdp.isAvailable()
    const ws = await connected()
    const stop = autoDrain(ws, null)
    await p
    stop()
    await cdp.dispose()
    expect(adb.removeForward).toHaveBeenCalled()
  })

})
