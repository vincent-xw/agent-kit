import { describe, expect, it } from 'vitest'

import { createLlmVerboseLogger } from './console-audit.js'
import type { LlmTraceEvent } from './llm-client.js'

describe('createLlmVerboseLogger', () => {
  it('request 阶段输出消息摘要与完整请求体', () => {
    const lines: string[] = []
    const logger = createLlmVerboseLogger({ sink: { log: (message: string) => lines.push(message) } })
    logger({
      requestId: 'llm-test',
      phase: 'request',
      durationMs: 0,
      body: {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你在操作浏览器' },
          { role: 'user', content: '看看这个页面' },
        ],
        tools: [{ type: 'function', function: { name: 'browser_snapshot' } }],
      },
    })
    expect(lines[0]).toContain('→ llm-test')
    expect(lines[0]).toContain('model=deepseek-v4-flash')
    expect(lines[0]).toContain('tools=1')
    expect(lines[0]).toContain('system×1, user×1')
    // 请求体 JSON 紧跟在同一行字符串的换行之后。
    expect(lines[0]).toContain('你在操作浏览器')
  })

  it('response 阶段输出原始响应', () => {
    const lines: string[] = []
    const logger = createLlmVerboseLogger({ sink: { log: (message: string) => lines.push(message) } })
    logger({
      requestId: 'llm-r1',
      phase: 'response',
      durationMs: 120,
      responseBody: { choices: [{ message: { content: '页面上有 2 个元素' } }] },
    })
    expect(lines[0]).toContain('← llm-r1')
    expect(lines[0]).toContain('120ms')
    expect(lines[0]).toContain('页面上有 2 个元素')
  })

  it('error 阶段输出错误信息', () => {
    const lines: string[] = []
    const logger = createLlmVerboseLogger({ sink: { log: (message: string) => lines.push(message) } })
    logger({
      requestId: 'llm-e1',
      phase: 'error',
      durationMs: 30,
      responseBody: { status: 400, detail: 'An assistant message with tool_calls must be followed by tool messages' },
    })
    expect(lines[0]).toContain('✗ llm-e1')
    expect(lines[0]).toContain('An assistant message with tool_calls')
  })

  it('disabled 时不输出', () => {
    const lines: string[] = []
    const logger = createLlmVerboseLogger({ enabled: false, sink: { log: (message: string) => lines.push(message) } })
    const event: LlmTraceEvent = { requestId: 'llm-x', phase: 'request', durationMs: 0, body: { model: 'm' } }
    logger(event)
    expect(lines).toHaveLength(0)
  })
})
