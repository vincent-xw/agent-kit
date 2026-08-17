import type { AdbClient } from './adb-client.js'
import type { SnapshotProvider } from './device-provider.js'
import type { DeviceSnapshot } from '../types.js'
import type { DeviceNode } from '../types.js'

const COMPANION_PORT = 7777

/**
 * 通过 Android Companion App 获取设备无障碍树。
 *
 * 工作方式：
 * 1. adb forward tcp:<本地端口> tcp:7777
 * 2. HTTP GET /tree 获取节点树 JSON
 * 3. HTTP POST /node/:ref/click 等操作
 *
 * 与 UiAutomatorDumpProvider 相比：
 * - 更快（无 adb uiautomator dump 开销）
 * - 支持 Unicode 输入（ACTION_SET_TEXT）
 * - 支持事件流
 */
export class CompanionProvider implements SnapshotProvider {
  private localPort = 0
  private baseUrl = ''

  constructor(private readonly adb: AdbClient) {}

  private async ensureForward(): Promise<void> {
    if (this.localPort !== 0) return
    this.localPort = await this.findFreePort(9400)
    await this.adb.forward(this.localPort, `tcp:${COMPANION_PORT}`)
    this.baseUrl = `http://127.0.0.1:${this.localPort}`
  }

  async snapshot(): Promise<DeviceSnapshot> {
    await this.ensureForward()
    const res = await fetch(`${this.baseUrl}/tree`)
    if (!res.ok) throw new Error(`Companion /tree 返回 ${res.status}`)
    const data = (await res.json()) as {
      snapshotId: string
      packageName: string
      screenWidth: number
      screenHeight: number
      nodes: Array<{
        ref: number
        nodeId: string
        text?: string
        contentDescription?: string
        className?: string
        resourceId?: string
        bounds: { left: number; top: number; right: number; bottom: number }
        clickable: boolean
        scrollable: boolean
        editable: boolean
        enabled: boolean
        focused: boolean
        checked?: boolean
        selected?: boolean
      }>
    }
    return data as DeviceSnapshot
  }

  async tapNode(ref: number): Promise<{ ok: boolean; message: string }> {
    await this.ensureForward()
    const res = await fetch(`${this.baseUrl}/node/${ref}/click`, { method: 'POST' })
    return res.json() as Promise<{ ok: boolean; message: string }>
  }

  async setText(ref: number, text: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureForward()
    const res = await fetch(`${this.baseUrl}/node/${ref}/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return res.json() as Promise<{ ok: boolean; message: string }>
  }

  async scrollNode(ref: number, direction: 'forward' | 'backward'): Promise<{ ok: boolean; message: string }> {
    await this.ensureForward()
    const res = await fetch(`${this.baseUrl}/node/${ref}/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction }),
    })
    return res.json() as Promise<{ ok: boolean; message: string }>
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