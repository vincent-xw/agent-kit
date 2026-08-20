import { describe, it, expect } from 'vitest'
import type { ToolDefinition } from '@agent-kit/core'
import { createAskService } from '../services/ask-service.js'
import { createUserInteractionToolDefinitions } from './user-interaction-tools.js'

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

function run(t: ToolDefinition, input: unknown, context: unknown) {
  return (t.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(input, context)
}

describe('用户交互工具', () => {
  function make() {
    let lastCallId = ''
    const events: unknown[] = []
    const ask = createAskService({
      emit: (e) => { events.push(e); const c = e as { callId: string }; lastCallId = c.callId },
    })
    const tools = createUserInteractionToolDefinitions({ ask })
    return { ask, tools, getLast: () => lastCallId }
  }

  it('ask_user 阻塞并回填单选答案', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'ask_user')
    const p = run(t, { question: '选哪个', select: 'single', options: ['A', 'B'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), 'A')
    await expect(p).resolves.toMatchObject({ ok: true, answer: 'A' })
  })
  it('ask_user 多选回填数组', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'ask_user')
    const p = run(t, { question: '多选', select: 'multiple', options: ['x', 'y', 'z'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), ['x', 'z'])
    await expect(p).resolves.toMatchObject({ ok: true, answer: ['x', 'z'] })
  })
  it('ask_user 空 question 返回错误', async () => {
    const { tools } = make()
    const t = byName(tools, 'ask_user')
    const out = await run(t, { question: '  ', select: 'single' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(out.ok).toBe(false)
  })
  it('ask_user 多选选项不足 2 返回错误', async () => {
    const { tools } = make()
    const t = byName(tools, 'ask_user')
    const out = await run(t, { question: 'q', select: 'multiple', options: ['x'] }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(out.ok).toBe(false)
  })
  it('user_confirm 允许返回 allow', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: '写文件 /x', target: '/x' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), '允许')
    await expect(p).resolves.toMatchObject({ decision: 'allow' })
  })
  it('user_confirm 拒绝返回 deny', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: '执行 rm -rf' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    ask.resolve('flutter-dev:s1', getLast(), '拒绝')
    await expect(p).resolves.toMatchObject({ decision: 'deny' })
  })
  it('user_confirm 取消时返回 error', async () => {
    const { ask, tools, getLast } = make()
    const t = byName(tools, 'user_confirm')
    const p = run(t, { action: 'x' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    await new Promise((r) => setTimeout(r, 5))
    ask.cancel(getLast())
    await expect(p).resolves.toMatchObject({ error: 'cancelled' })
  })
})