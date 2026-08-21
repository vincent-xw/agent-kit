import { isAbsolute, join } from 'node:path'

export type LogFormat = 'verbose' | 'json' | 'audit'

export interface FileLogConfig {
  enabled: boolean
  dir: string
  format: LogFormat
  /** 保留文件天数；0 = 永久保留。仅启动读取。 */
  keepDays: number
}

const FORMATS: LogFormat[] = ['verbose', 'json', 'audit']

export function parseFileLogConfig(env: Record<string, string | undefined>, fallbackDir: string): FileLogConfig {
  const format = (env.LOG_FORMAT ?? 'verbose') as LogFormat
  const rawDir = env.LOG_DIR
  return {
    enabled: (env.LOG_TO_FILE ?? '1') !== '0',
    // 相对 LOG_DIR 以 BFF 数据目录为基准（如 LOG_DIR=log → <数据目录>/log）
    dir: rawDir
      ? isAbsolute(rawDir)
        ? rawDir
        : join(fallbackDir, rawDir)
      : join(fallbackDir, 'log'),
    format: FORMATS.includes(format) ? format : 'verbose',
    keepDays: Number(env.LOG_KEEP_DAYS ?? '7') || 0,
  }
}

type AuditLike = { requestId?: string; model?: string; toolName?: string; httpStatus?: number; durationMs?: number; errorCode?: string }

export function auditToJsonLine(event: AuditLike): string {
  const o: Record<string, unknown> = { kind: 'audit', requestId: event.requestId }
  if (event.model) o.model = event.model
  if (event.toolName) o.tool = event.toolName
  if (event.httpStatus !== undefined) o.http = event.httpStatus
  if (event.durationMs) o.ms = event.durationMs
  if (event.errorCode) o.error = event.errorCode
  return JSON.stringify(o)
}

type LlmLike = { phase: 'request' | 'response' | 'error'; requestId: string; durationMs: number; body?: unknown; responseBody?: unknown; error?: unknown }

export function llmToJsonLine(event: LlmLike): string {
  const o: Record<string, unknown> = { kind: 'llm', phase: event.phase, requestId: event.requestId, durationMs: event.durationMs }
  if (event.phase === 'request') {
    const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
    o.model = body.model
    o.tools = Array.isArray(body.tools) ? body.tools.length : 0
    o.messages = body.messages // 含完整 prompt/会话历史（与 verbose 同级的敏感信息）
  } else if (event.phase === 'response') {
    o.responseBody = event.responseBody
  } else {
    o.error = event.error
  }
  return JSON.stringify(o)
}