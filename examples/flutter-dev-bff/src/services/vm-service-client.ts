import { EventEmitter } from 'node:events'

interface RpcResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  method?: string
  params?: unknown
}

function toWebSocketUri(httpUri: string): string {
  const url = new URL(httpUri)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (!url.pathname.endsWith('/ws')) {
    url.pathname = url.pathname.replace(/\/?$/, '/ws')
  }
  return url.toString()
}

export class VmServiceClient extends EventEmitter {
  private ws: WebSocket | null = null
  private requestId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private uri: string

  constructor(vmServiceUri: string) {
    super()
    this.uri = toWebSocketUri(vmServiceUri)
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.uri)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('VM Service WebSocket 连接失败'))
      this.ws.onmessage = (event) => this.handleMessage(event.data.toString())
      this.ws.onclose = () => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('VM Service 连接已关闭'))
        }
        this.pending.clear()
        this.emit('close')
      }
    })
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  private handleMessage(data: string): void {
    let message: RpcResponse
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) {
        reject(new Error(`VM Service 错误: ${message.error.message}`))
      } else {
        resolve(message.result)
      }
    } else if (message.method) {
      this.emit('event', message.method, message.params)
    }
  }

  private send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('VM Service 未连接'))
    }
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async getVm(): Promise<{ isolates: Array<{ id: string; name: string; number: string }> }> {
    const result = await this.send<{ isolates: Array<{ id: string; name: string; number: string }> }>('getVM')
    return result
  }

  async evaluate(expression: string): Promise<{ result?: string; error?: string }> {
    const vm = await this.getVm()
    const isolate = vm.isolates.find((i) => i.name === 'main') ?? vm.isolates[0]
    if (!isolate) return { error: '没有找到活动的 isolate' }
    try {
      const result = await this.send<{ type: string; valueAsString?: string; response?: { type: string; message?: string } }>(
        'evaluate',
        { isolateId: isolate.id, expression, disableBreakpoints: true },
      )
      if (result.type === '@Error' || result.type === 'Sentinel') {
        return { error: result.valueAsString ?? String(result) }
      }
      if (result.response?.type === 'Error') {
        return { error: result.response.message ?? JSON.stringify(result.response) }
      }
      return { result: result.valueAsString ?? JSON.stringify(result) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async reloadSources(): Promise<{ ok: boolean; message: string }> {
    const vm = await this.getVm()
    const isolate = vm.isolates.find((i) => i.name === 'main') ?? vm.isolates[0]
    if (!isolate) return { ok: false, message: '没有找到活动的 isolate' }
    try {
      await this.send('reloadSources', { isolateId: isolate.id })
      return { ok: true, message: '热重载已触发' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '热重载失败' }
    }
  }
}
