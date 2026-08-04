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
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? { type: 'tool_call', callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }
            : { type: 'final', output: '上海 26 度' }
        },
      },
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

  it('工具输入不符合 Schema 返回 TOOL_INPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather.read',
      execution: 'server',
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-4', toolName: 'weather.read', input: { city: 123 } }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-4', input: '查询天气', context: {} })).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' })
  })

  it('工具输出不符合 Schema 返回 TOOL_OUTPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather.read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 'hot' }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-5', toolName: 'weather.read', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-5', input: '查询天气', context: {} })).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' })
  })

  it('达到最大步数返回 HARNESS_STEP_LIMIT', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'loop.tick',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-6', toolName: 'loop.tick', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await expect(harness.run({ sessionId: 's-6', input: '循环', context: {} })).rejects.toMatchObject({ code: 'HARNESS_STEP_LIMIT' })
  })

  it('远端工具结果通过 resume 回填后进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({ name: 'browser.read_page', execution: 'remote', input: z.object({ url: z.string() }), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? { type: 'tool_call', callId: 'call-7', toolName: 'browser.read_page', input: { url: 'https://example.test' } }
            : { type: 'final', output: '页面标题：首页' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const pending = await harness.run({ sessionId: 's-7', input: '读取页面', context: {} })
    expect(pending).toMatchObject({ type: 'pending_tool_call', toolName: 'browser.read_page' })
    await expect(harness.resume({ sessionId: 's-7', callId: 'call-7', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '页面标题：首页' })
    expect(requests).toHaveLength(2)
  })

  it('跨 session 回填被拒绝', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser.read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-8', toolName: 'browser.read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-8', input: '读取页面', context: {} })
    await expect(harness.resume({ sessionId: 's-other', callId: 'call-8', output: { title: 'x' } })).rejects.toMatchObject({ code: 'PENDING_CALL_NOT_FOUND' })
  })

  it('resume 的工具输出不符合 Schema 返回 TOOL_OUTPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser.read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'tool_call', callId: 'call-9', toolName: 'browser.read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-9', input: '读取页面', context: {} })
    await expect(harness.resume({ sessionId: 's-9', callId: 'call-9', output: { title: 123 } })).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' })
  })
})
