import { describe, it, expect } from 'vitest'
import { parseFileLogConfig, auditToJsonLine, llmToJsonLine } from './log-format.js'

describe('parseFileLogConfig', () => {
  it('默认值：开启、verbose、fallback 目录、7 天', () => {
    const c = parseFileLogConfig({}, '/data')
    expect(c).toMatchObject({ enabled: true, dir: '/data/logs', format: 'verbose', keepDays: 7 })
  })
  it('LOG_TO_FILE=0 关闭', () => {
    expect(parseFileLogConfig({ LOG_TO_FILE: '0' }, '/d').enabled).toBe(false)
  })
  it('LOG_DIR/LOG_FORMAT/LOG_KEEP_DAYS 生效', () => {
    const c = parseFileLogConfig({ LOG_DIR: '/x', LOG_FORMAT: 'json', LOG_KEEP_DAYS: '0' }, '/d')
    expect(c).toMatchObject({ dir: '/x', format: 'json', keepDays: 0 })
  })
  it('非法格式回退 verbose', () => {
    expect(parseFileLogConfig({ LOG_FORMAT: 'nope' }, '/d').format).toBe('verbose')
  })
})

describe('auditToJsonLine', () => {
  it('输出单行 JSON，含关键字段', () => {
    const line = auditToJsonLine({ requestId: 'r1', model: 'm', toolName: 't', durationMs: 5, errorCode: 'E' })
    const o = JSON.parse(line) as Record<string, unknown>
    expect(o).toMatchObject({ kind: 'audit', requestId: 'r1', model: 'm', tool: 't', ms: 5, error: 'E' })
  })
})

describe('llmToJsonLine', () => {
  it('request 相位带 messages 与 tools 数', () => {
    const line = llmToJsonLine({ phase: 'request', requestId: 'r1', durationMs: 0, body: { model: 'm', messages: [{ role: 'user' }], tools: [{}] } })
    const o = JSON.parse(line) as Record<string, unknown>
    expect(o).toMatchObject({ kind: 'llm', phase: 'request', requestId: 'r1', model: 'm', tools: 1 })
    expect(Array.isArray(o.messages)).toBe(true)
  })
  it('response 相位带 responseBody', () => {
    const o = JSON.parse(llmToJsonLine({ phase: 'response', requestId: 'r1', durationMs: 3, responseBody: { choices: [] } })) as Record<string, unknown>
    expect(o.responseBody).toEqual({ choices: [] })
  })
})