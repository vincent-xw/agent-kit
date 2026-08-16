import type { AdbClient } from '../adb-client.js'
import { domToNodes, type DomElement } from './dom-to-nodes.js'
import type { DeviceSnapshot } from '../../types.js'

/** 注入到 WebView 里抓取可交互/有文本元素的 JS。 */
const SCAN_JS = `(() => {
  const isVisible = el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const isInteractive = el =>
    ['A','BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName) ||
    el.getAttribute('role') === 'button' || el.hasAttribute('onclick') ||
    el.isContentEditable;
  const cssPath = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.parentElement) {
        const same = Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  return JSON.stringify(Array.from(document.querySelectorAll('*'))
    .filter(el => isVisible(el) && (isInteractive(el) || (el.innerText || el.textContent || '').trim()))
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 200),
        id: el.id || undefined,
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('alt') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        selector: el.id ? '#' + CSS.escape(el.id) : cssPath(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        clickable: isInteractive(el),
        editable: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && !el.disabled,
        scrollable: el.scrollHeight > el.clientHeight,
        enabled: !el.disabled,
      };
    }));
})()`

interface CdpTarget {
  id: string
  type: string
  webSocketDebuggerUrl: string
}

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

/** CdpClient 实际用到的 WebSocket 子集，便于测试注入假实现。 */
export interface CdpWebSocket {
  addEventListener(type: string, listener: (ev?: { data?: string }) => void): void
  removeEventListener(type: string, listener: (ev?: { data?: string }) => void): void
  send(data: string): void
  close(): void
}

/**
 * 通过 Chrome DevTools Protocol 操作 App 内 WebView。
 *
 * 使用懒连接：每个公开方法调 ensure()，未连接时走一遍发现→forward→握手。
 * 探测失败（无 socket、/json 不可达）时不抛连接错误，而是让 isAvailable 返回 false，
 * 以便上层 web_* 工具给出明确提示而非崩溃。
 */
export class CdpClient {
  private localPort: number | null = null
  private socket: string | null = null
  private conn: CdpConnection | null = null
  private devicePixelRatio = 1
  /** ref(1-based) -> 元素 selector，每次 snapshot 重建。 */
  private refs = new Map<number, string>()

  constructor(
    private readonly adb: AdbClient,
    private readonly options: {
      wsFactory?: (url: string) => CdpWebSocket
      fetchImpl?: typeof fetch
      basePort?: number
    } = {},
  ) {}

  private get wsFactory(): (url: string) => CdpWebSocket {
    return this.options.wsFactory ?? ((url) => new WebSocket(url) as unknown as CdpWebSocket)
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensure()
      return true
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    this.conn?.close()
    this.conn = null
    if (this.localPort !== null) {
      await this.adb.removeForward(this.localPort).catch(() => {})
      this.localPort = null
    }
    this.socket = null
    this.refs.clear()
  }

  async snapshot(): Promise<DeviceSnapshot> {
    await this.ensure()
    const conn = this.conn!
    const dprResult = await conn.send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true })
    this.devicePixelRatio = Number((dprResult as { result?: { value?: number } }).result?.value ?? 1)

    const scanResult = await conn.send('Runtime.evaluate', { expression: SCAN_JS, returnByValue: true })
    const json = (scanResult as { result?: { value?: string } }).result?.value ?? '[]'
    const elements: DomElement[] = JSON.parse(json)
    const { nodes } = domToNodes(elements, { devicePixelRatio: this.devicePixelRatio })

    this.refs.clear()
    elements.forEach((e, i) => {
      // selector 不在 DomElement 里——从原始 elements 取
      this.refs.set(i + 1, (e as DomElement & { selector?: string }).selector ?? '')
    })

    return {
      snapshotId: `web:${Date.now()}`,
      packageName: 'webview',
      screenWidth: 0,
      screenHeight: 0,
      nodes,
    }
  }

  async tap(ref: number): Promise<void> {
    await this.ensure()
    const selector = this.requireSelector(ref)
    // 移动 WebView 上 Input.dispatchMouseEvent 不一定触发 click（触摸 vs 鼠标模型），
    // 对有 selector 的元素直接调用 .click() 最可靠。
    await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('element not found'); el.click(); })()`,
    )
  }

  async setText(ref: number, text: string): Promise<void> {
    await this.ensure()
    const selector = this.requireSelector(ref)
    // 直接设值并触发 input/change 事件，比 Input.insertText 在移动 WebView 上更可靠。
    await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('element not found'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    )
  }

  async scroll(ref: number, direction: 'forward' | 'backward'): Promise<void> {
    await this.ensure()
    const selector = this.requireSelector(ref)
    const dy = direction === 'forward' ? 400 : -400
    const box = await this.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
    )
    const x = box.x * this.devicePixelRatio
    const y = box.y * this.devicePixelRatio
    await this.conn!.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy * this.devicePixelRatio,
    })
  }

  private requireSelector(ref: number): string {
    const selector = this.refs.get(ref)
    if (!selector) throw new Error(`web 节点引用已过期，请重新 web_snapshot`)
    return selector
  }

  private async eval<T>(expression: string): Promise<T> {
    const result = await this.conn!.send('Runtime.evaluate', { expression, returnByValue: true })
    // conn.send 已解包 CDP 的 result 字段，这里 result 是 { type, value }
    return (result as { result?: { value?: T } }).result?.value as T
  }

  private async ensure(): Promise<void> {
    if (this.conn) {
      // 轻量存活检查
      try {
        await this.conn.send('Runtime.evaluate', { expression: '1', returnByValue: true })
        return
      } catch {
        await this.dispose()
      }
    }
    const sockets = await this.adb.listWebViewSockets()
    if (sockets.length === 0) throw new Error('未发现可调试的 WebView')
    this.socket = sockets[0]!

    // 找空闲本地端口
    const base = this.options.basePort ?? 9300
    this.localPort = await this.findFreePort(base)
    await this.adb.forward(this.localPort, `localabstract:${this.socket}`)

    const targets = await this.fetchJson<CdpTarget[]>(`/json`)
    const page = targets.find((t) => t.type === 'page') ?? targets[0]
    if (!page?.webSocketDebuggerUrl) throw new Error('CDP /json 未返回可调试页面')

    this.conn = await this.connect(page.webSocketDebuggerUrl)
    await this.conn.send('Runtime.enable')
    await this.conn.send('DOM.enable')
    await this.conn.send('Page.enable')
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`http://127.0.0.1:${this.localPort}${path}`)
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  private connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = this.wsFactory(url)
      let nextId = 1
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
      const onOpen = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        resolve({
          send: (method, params) => {
            const id = nextId++
            ws.send(JSON.stringify({ id, method, params: params ?? {} }))
            return new Promise<unknown>((res, rej) => pending.set(id, { resolve: res, reject: rej }))
          },
          close: () => {
            ws.close()
            pending.forEach((p) => p.reject(new Error('CDP 连接已关闭')))
            pending.clear()
          },
        })
      }
      const onError = () => reject(new Error('CDP WebSocket 连接失败'))
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('message', (ev) => {
        if (!ev?.data) return
        let msg: { id?: number; result?: unknown; error?: { message?: string } }
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id === undefined) return
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP 错误'))
        else p.resolve(msg.result)
      })
    })
  }

  private async findFreePort(start: number): Promise<number> {
    const net = await import('node:net')
    for (let port = start; port < start + 100; port++) {
      const inUse = await new Promise<boolean>((resolve) => {
        const srv = net.createServer()
        srv.once('error', () => resolve(true))
        srv.once('listening', () => srv.close(() => resolve(false)))
        srv.listen(port, '127.0.0.1')
      })
      if (!inUse) return port
    }
    throw new Error('找不到空闲本地端口')
  }
}
