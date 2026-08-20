import { describe, expect, it } from 'vitest'
import { renderSessionMarkdown } from './session-export.js'
import type { SessionMessage } from '@agent-kit/core'

const messages: SessionMessage[] = [
  { role: 'user', content: '启动应用' },
  { role: 'assistant', content: '我来启动应用', toolCalls: [{ callId: 'c1', toolName: 'flutter_run', input: { mode: 'run' } }] },
  { role: 'tool', content: { ok: true, deviceId: 'emu-1' }, callId: 'c1', toolName: 'flutter_run' },
  { role: 'assistant', content: '已启动' },
]

describe('renderSessionMarkdown', () => {
  it('按时间顺序渲染用户/助手/工具调用', () => {
    const md = renderSessionMarkdown('首页调试', messages, 20000)
    expect(md).toContain('# 会话: 首页调试')
    expect(md.indexOf('## 用户\n\n启动应用')).toBeGreaterThan(-1)
    expect(md.indexOf('## 助手\n\n我来启动应用')).toBeGreaterThan(-1)
    expect(md).toContain('## 工具调用: flutter_run')
    expect(md).toContain('"mode": "run"')
    expect(md).toContain('"ok": true')
    const order = [
      md.indexOf('## 用户'),
      md.indexOf('## 助手\n\n我来启动应用'),
      md.indexOf('## 工具调用: flutter_run'),
      md.indexOf('## 助手\n\n已启动'),
    ]
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1]!)
  })

  it('超过上限的工具输出截断并标注总长度', () => {
    const big: SessionMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 'big_tool', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(5000) }, callId: 'c1', toolName: 'big_tool' },
    ]
    const md = renderSessionMarkdown('t', big, 1000)
    expect(md).toContain('已截断，共 ')
    expect(md).not.toContain('x'.repeat(1500))
  })

  it('toolOutputLimit 为 0 不截断', () => {
    const big: SessionMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 'big_tool', input: {} }] },
      { role: 'tool', content: { data: 'x'.repeat(5000) }, callId: 'c1', toolName: 'big_tool' },
    ]
    const md = renderSessionMarkdown('t', big, 0)
    expect(md).toContain('x'.repeat(5000))
  })

  it('未回填的调用输出标注无结果', () => {
    const md = renderSessionMarkdown('t', [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
    ], 20000)
    expect(md).toContain('（无结果）')
  })
})
