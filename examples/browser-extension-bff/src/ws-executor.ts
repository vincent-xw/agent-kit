import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'

export interface WsToolCall {
  callId: string
  toolName: string
  input: unknown
}

export function createWsExecutor(options: {
  authenticate: (request: IncomingMessage) => Promise<{ subject: string } | null>
  onConnectionChange?: (online: boolean, info?: { tabUrl?: string; tabTitle?: string }) => void
}) {
  let activeSocket: WebSocket | null = null
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let executorInfo: { tabUrl?: string; tabTitle?: string } = {}

  return {
    handleUpgrade(request: IncomingMessage, ws: WebSocket, head: Buffer): boolean {
      const tokenMatch = request.url?.match(/[?&]token=([^&]+)/)
      const token = tokenMatch?.[1] ? decodeURIComponent(tokenMatch[1]) : ''
      if (!token) return false

      // 已有连接时关闭旧的，新连接优先
      if (activeSocket) {
        try { activeSocket.close(1000, 'replaced') } catch { /* 忽略已关闭的连接 */ }
      }

      activeSocket = ws
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'register') {
            executorInfo = { tabUrl: msg.tabUrl, tabTitle: msg.tabTitle }
            options.onConnectionChange?.(true, executorInfo)
          } else if (msg.type === 'tool_result') {
            const p = pending.get(msg.callId)
            if (p) {
              clearTimeout(p.timer)
              p.resolve(msg.output)
              pending.delete(msg.callId)
            }
          }
        } catch {
          // 消息格式错误，忽略
        }
      })
      ws.on('close', () => {
        activeSocket = null
        options.onConnectionChange?.(false)
        // 拒绝所有挂起的调用
        for (const [, p] of pending) {
          clearTimeout(p.timer)
          p.reject(new Error('EXECUTOR_DISCONNECTED'))
        }
        pending.clear()
      })
      ws.on('error', () => {
        // close 会紧随其后，不重复处理
      })
      return true
    },

    async executeTool(call: WsToolCall, timeoutMs = 60_000): Promise<unknown> {
      const sock = activeSocket
      if (!sock) throw new Error('EXECUTOR_NOT_CONNECTED')
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(call.callId)
          reject(new Error('EXECUTOR_TIMEOUT'))
        }, timeoutMs)
        pending.set(call.callId, { resolve, reject, timer })
        try {
          sock.send(JSON.stringify({ type: 'tool_call', callId: call.callId, toolName: call.toolName, input: call.input }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(call.callId)
          reject(error instanceof Error ? error : new Error('EXECUTOR_SEND_FAILED'))
        }
      })
    },

    get online() { return activeSocket !== null },
    get clientInfo() { return { ...executorInfo } },
  }
}

export type WsExecutor = ReturnType<typeof createWsExecutor>