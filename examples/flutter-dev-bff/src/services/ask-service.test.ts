import { describe, it, expect } from 'vitest'
import { createAskService } from './ask-service.js'

function fakeBus() {
  const events: Array<Record<string, unknown>> = []
  return { emit: (e: { type: string; [k: string]: unknown }) => { events.push(e) }, events }
}

describe('AskService', () => {
  it('awaitAnswer 发出 ask_user 事件并等待 resolve', async () => {
    const bus = fakeBus()
    const s = createAskService(bus)
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: '选', options: ['A'], select: 'single' })
    expect(bus.events[0]).toMatchObject({ type: 'ask_user', sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: '选' })
    expect(s.resolve('flutter-dev:s1', 'c1', 'A')).toBe(true)
    await expect(p).resolves.toBe('A')
  })
  it('resolve 校验 session 归属', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'approval', question: 'q', options: [], select: 'single' })
    expect(s.resolve('flutter-dev:OTHER', 'c1', '允许')).toBe(false)
    expect(s.resolve('flutter-dev:s1', 'c1', '允许')).toBe(true)
    await expect(p).resolves.toBe('允许')
  })
  it('cancel 使 awaitAnswer reject', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'approval', question: 'q', options: [], select: 'single' }).catch((e: Error) => e.message)
    s.cancel('c1')
    await expect(p).resolves.toBe('cancelled')
  })
  it('重复 resolve 返回 false 且只生效一次', async () => {
    const s = createAskService(fakeBus())
    const p = s.awaitAnswer({ sessionId: 'flutter-dev:s1', callId: 'c1', kind: 'question', question: 'q', options: [], select: 'single' })
    expect(s.resolve('flutter-dev:s1', 'c1', 'A')).toBe(true)
    expect(s.resolve('flutter-dev:s1', 'c1', 'B')).toBe(false)
    await expect(p).resolves.toBe('A')
  })
})