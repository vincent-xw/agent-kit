import type { AuditEvent, AuditLogger } from './contracts.js'

/**
 * 控制台审计日志。
 *
 * `AuditLogger` 接口一直存在、harness 也一直在调，但此前没有任何实现被注入 ——
 * 结果是服务端完全没有可观测性，一个 LLM 400 只能看到扩展侧一句「LLM 返回 HTTP 400」。
 *
 * 红线（与 docs/security.md 一致）：不记录密钥、Prompt 正文、模型原文与业务上下文。
 * 只记 requestId、模型、耗时、HTTP 状态、工具名与错误码 —— 这些足够定位问题，
 * 又不会把业务数据写进日志文件。
 */

export interface ConsoleAuditOptions {
  /** 是否输出。默认开启；设为 false 可完全静音。 */
  enabled?: boolean
  /** 日志前缀，便于在混合输出里筛选。 */
  prefix?: string
  /** 输出目标，默认 console。测试时可注入。 */
  sink?: { log(message: string): void; error(message: string): void }
}

/** 把审计事件格式化为单行文本。字段缺失时省略而不是打印 undefined。 */
function formatEvent(event: AuditEvent): string {
  const parts = [`req=${event.requestId}`]
  if (event.model) parts.push(`model=${event.model}`)
  if (event.toolName) parts.push(`tool=${event.toolName}`)
  if (event.httpStatus !== undefined) parts.push(`http=${event.httpStatus}`)
  if (event.durationMs > 0) parts.push(`${event.durationMs}ms`)
  if (event.errorCode) parts.push(`error=${event.errorCode}`)
  return parts.join(' ')
}

export function createConsoleAuditLogger(options: ConsoleAuditOptions = {}): AuditLogger {
  const enabled = options.enabled ?? true
  const prefix = options.prefix ?? '[agent-kit]'
  const sink = options.sink ?? { log: (message: string) => console.log(message), error: (message: string) => console.error(message) }
  return {
    log(event) {
      if (!enabled) return
      const line = `${prefix} ${formatEvent(event)}`
      // 带错误码的走 error 流，便于 `2>` 单独收集。
      if (event.errorCode) sink.error(line)
      else sink.log(line)
    },
  }
}

/**
 * 把 AgentKitError 之外的失败也记一笔。
 *
 * harness 的 audit 只覆盖它自己发起的调用；BFF 边界上抛出的异常需要单独记，
 * 否则「请求进来了但报错了」这件事在服务端不留痕迹。
 */
export function logBoundaryError(
  audit: AuditLogger | undefined,
  requestId: string,
  errorCode: string,
  durationMs = 0,
): void {
  void audit?.log({ requestId, durationMs, errorCode })
}
