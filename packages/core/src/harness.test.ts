import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AgentKitError, createAgentHarness, createMemorySessionStore, createToolRegistry } from './index.js'

describe('AgentHarness', () => {
  it('服务端工具结果会进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({
      name: 'weather.read',
      execution: 'server',
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? { type: 'tool_call', callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }
          : { type: 'final', output: '上海 26 度' }
      } },
      sessions: createMemorySessionStore(),
      tools,
      maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-1', input: '查询天气', context: {} })).resolves.toEqual({ type: 'final', output: '上海 26 度' })
    expect(requests).toHaveLength(2)
  })

  it('远端工具返回待执行调用且不在服务端执行', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser.read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-2', toolName: 'browser.read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-2', input: '读取页面', context: {} })).resolves.toEqual({ type: 'pending_tool_call', callId: 'call-2', toolName: 'browser.read_page', input: {} })
  })

  it('未注册工具返回稳定错误码', async () => {
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-3', toolName: 'unknown', input: {} }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-3', input: '执行未知工具', context: {} })).rejects.toMatchObject({ code: 'TOOL_NOT_REGISTERED' } satisfies Partial<AgentKitError>)
  })
})
