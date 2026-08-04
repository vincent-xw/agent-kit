import { describe, expect, it } from 'vitest'

import { createContextManager } from './index.js'

describe('ContextManager', () => {
  it('保存与追加消息', () => {
    const manager = createContextManager({ maxMessages: 5 })
    manager.save('s-1', [{ role: 'user', content: '你好' }])
    manager.append('s-1', { role: 'tool', content: { ok: true } })
    expect(manager.load('s-1')).toHaveLength(2)
  })

  it('超过窗口时裁剪最旧消息并记录摘要', () => {
    const manager = createContextManager({ maxMessages: 3 })
    manager.save('s-1', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    const loaded = manager.load('s-1')
    expect(loaded).toHaveLength(3)
    expect(loaded[0]).toEqual({ role: 'user', content: '2' })
    expect(manager.getSummary('s-1')).toBe('已裁剪 1 条历史消息')
  })

  it('未发生裁剪时摘要为空', () => {
    const manager = createContextManager({ maxMessages: 5 })
    manager.save('s-1', [{ role: 'user', content: '1' }])
    expect(manager.getSummary('s-1')).toBeUndefined()
  })
})
