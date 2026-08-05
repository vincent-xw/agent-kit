import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AgentKitError, createAgentHarness, createContextManager, createMemorySessionStore, createPromptRegistry, createToolRegistry } from './index.js'
import type { LlmResult, PendingCall, PendingCallStore, SessionMessage, ToolCall } from './index.js'

/** 构造单个工具调用的模型响应，避免每处重复写复数壳。 */
function callsOf(...calls: ToolCall[]): LlmResult {
  return { type: 'tool_calls', calls }
}

describe('AgentHarness', () => {
  it('服务端工具结果会进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
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
            ? callsOf({ callId: 'call-1', toolName: 'weather_read', input: { city: '上海' } })
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
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-2', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-2', input: '读取页面', context: {} })).resolves.toEqual({
      type: 'pending_tool_calls',
      calls: [{ callId: 'call-2', toolName: 'browser_read_page', input: {} }],
    })
  })

  it('未注册工具返回稳定错误码', async () => {
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-3', toolName: 'unknown', input: {} }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-3', input: '执行未知工具', context: {} })).rejects.toMatchObject({ code: 'TOOL_NOT_REGISTERED' } satisfies Partial<AgentKitError>)
  })

  it('工具输入不符合 Schema 返回 TOOL_INPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-4', toolName: 'weather_read', input: { city: 123 } }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-4', input: '查询天气', context: {} })).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' })
  })

  it('工具输出不符合 Schema 返回 TOOL_OUTPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 'hot' }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-5', toolName: 'weather_read', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-5', input: '查询天气', context: {} })).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' })
  })

  it('达到最大步数返回 HARNESS_STEP_LIMIT', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'loop_tick',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-6', toolName: 'loop_tick', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await expect(harness.run({ sessionId: 's-6', input: '循环', context: {} })).rejects.toMatchObject({ code: 'HARNESS_STEP_LIMIT' })
  })

  it('远端工具结果通过 resume 回填后进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({ url: z.string() }), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-7', toolName: 'browser_read_page', input: { url: 'https://example.test' } })
            : { type: 'final', output: '页面标题：首页' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const pending = await harness.run({ sessionId: 's-7', input: '读取页面', context: {} })
    expect(pending).toMatchObject({ type: 'pending_tool_calls', calls: [{ toolName: 'browser_read_page' }] })
    await expect(harness.resume({ sessionId: 's-7', callId: 'call-7', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '页面标题：首页' })
    expect(requests).toHaveLength(2)
  })

  it('跨 session 回填被拒绝', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-8', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-8', input: '读取页面', context: {} })
    await expect(harness.resume({ sessionId: 's-other', callId: 'call-8', output: { title: 'x' } })).rejects.toMatchObject({ code: 'PENDING_CALL_NOT_FOUND' })
  })

  it('resume 的工具输出不符合 Schema 返回 TOOL_OUTPUT_INVALID', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-9', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-9', input: '读取页面', context: {} })
    await expect(harness.resume({ sessionId: 's-9', callId: 'call-9', output: { title: 123 } })).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' })
  })

  it('把已注册工具的 JSON Schema 发给模型', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'browser_click',
      execution: 'remote',
      description: '在给定坐标执行真实点击',
      input: z.object({ x: z.number(), y: z.number(), label: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
    })
    let seen: unknown
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.tools
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await harness.run({ sessionId: 's-10', input: '点击', context: {} })
    expect(seen).toEqual([
      {
        name: 'browser_click',
        description: '在给定坐标执行真实点击',
        parameters: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } },
          required: ['x', 'y'],
        },
      },
    ])
  })

  it('注册表为空时不发送 tools 字段', async () => {
    let seen: unknown = 'unset'
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.tools
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2,
    })

    await harness.run({ sessionId: 's-11', input: '你好', context: {} })
    expect(seen).toBeUndefined()
  })

  it('assistant 轮次与工具结果成对入库且顺序正确', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1 ? callsOf({ callId: 'call-a', toolName: 'weather_read', input: {} }) : { type: 'final', output: '26 度' }
        },
      },
      sessions, tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-12', input: '查天气', context: {} })
    const history = (await sessions.load('s-12')) as SessionMessage[]
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history[1]).toMatchObject({ role: 'assistant', toolCalls: [{ callId: 'call-a', toolName: 'weather_read' }] })
    expect(history[2]).toMatchObject({ role: 'tool', callId: 'call-a' })
  })

  it('模型看到自己的上一轮 assistant 输出', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const seenHistories: SessionMessage[][] = []
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenHistories.push([...request.messages])
          step += 1
          return step === 1 ? callsOf({ callId: 'call-b', toolName: 'weather_read', input: {} }) : { type: 'final', output: '26 度' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-13', input: '查天气', context: {} })
    expect(seenHistories[1]?.some((message) => message.role === 'assistant')).toBe(true)
  })

  it('一轮内多个工具调用全部执行', async () => {
    const executed: string[] = []
    const tools = createToolRegistry()
    for (const name of ['a_run', 'b_run']) {
      tools.register({
        name,
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => {
          executed.push(name)
          return { ok: true }
        },
      })
    }
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'a_run', input: {} }, { callId: 'c2', toolName: 'b_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-14', input: '并行', context: {} })
    expect(executed).toEqual(['a_run', 'b_run'])
  })

  it('一轮内部分工具失败时失败与成功结果一并回传', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'ok_run',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    tools.register({
      name: 'bad_run',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => {
        throw new Error('炸了')
      },
    })
    const seenHistories: SessionMessage[][] = []
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenHistories.push([...request.messages])
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'ok_run', input: {} }, { callId: 'c2', toolName: 'bad_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-15', input: '混合', context: {} })
    const second = seenHistories[1] ?? []
    const toolMessages = second.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.some((message) => (message.content as { ok?: boolean }).ok === false)).toBe(true)
  })

  it('多个远端调用需全部回填后才推进模型', async () => {
    const tools = createToolRegistry()
    for (const name of ['r1_run', 'r2_run']) {
      tools.register({ name, execution: 'remote', input: z.object({}), output: z.object({ ok: z.boolean() }) })
    }
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'r1_run', input: {} }, { callId: 'c2', toolName: 'r2_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const pending = await harness.run({ sessionId: 's-16', input: '双远端', context: {} })
    expect(pending).toMatchObject({ type: 'pending_tool_calls' })
    expect((pending as { calls: unknown[] }).calls).toHaveLength(2)

    // 只回填第一个：仍应挂起，且模型未被推进。
    const partial = await harness.resume({ sessionId: 's-16', callId: 'c1', output: { ok: true } })
    expect(partial).toMatchObject({ type: 'pending_tool_calls', calls: [{ callId: 'c2' }] })
    expect(step).toBe(1)

    await expect(harness.resume({ sessionId: 's-16', callId: 'c2', output: { ok: true } })).resolves.toEqual({ type: 'final', output: 'done' })
  })

  it('工具执行超时返回 TOOL_EXECUTION_TIMEOUT 且循环继续', async () => {
    vi.useFakeTimers()
    try {
      const tools = createToolRegistry()
      tools.register({
        name: 'slow_run',
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        timeoutMs: 50,
        execute: (_input, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      const seenHistories: SessionMessage[][] = []
      let step = 0
      const harness = createAgentHarness({
        llm: {
          complete: async (request) => {
            seenHistories.push([...request.messages])
            step += 1
            return step === 1 ? callsOf({ callId: 'c1', toolName: 'slow_run', input: {} }) : { type: 'final', output: 'done' }
          },
        },
        sessions: createMemorySessionStore(), tools, maxSteps: 3,
      })

      const running = harness.run({ sessionId: 's-17', input: '慢工具', context: {} })
      await vi.advanceTimersByTimeAsync(100)
      await expect(running).resolves.toEqual({ type: 'final', output: 'done' })
      const toolMessage = (seenHistories[1] ?? []).find((message) => message.role === 'tool')
      expect(toolMessage?.content).toMatchObject({ ok: false, code: 'TOOL_EXECUTION_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('可注入自定义挂起调用存储', async () => {
    const store = new Map<string, PendingCall>()
    const pendingCalls: PendingCallStore = {
      get: (callId) => store.get(callId),
      set: (callId, call) => void store.set(callId, call),
      delete: (callId) => void store.delete(callId),
    }
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-x', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3, pendingCalls,
    })

    await harness.run({ sessionId: 's-18', input: '读取', context: {} })
    expect(store.get('call-x')).toEqual({ sessionId: 's-18', toolName: 'browser_read_page' })
  })

  it('注入的挂起存储使新 harness 实例也能回填', async () => {
    const store = new Map<string, PendingCall>()
    const pendingCalls: PendingCallStore = {
      get: (callId) => store.get(callId),
      set: (callId, call) => void store.set(callId, call),
      delete: (callId) => void store.delete(callId),
    }
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const deps = { sessions, tools, maxSteps: 3, pendingCalls }

    const first = createAgentHarness({ ...deps, llm: { complete: async () => callsOf({ callId: 'call-y', toolName: 'browser_read_page', input: {} }) } })
    await first.run({ sessionId: 's-19', input: '读取', context: {} })

    // 模拟进程重启：换一个 harness 实例，挂起调用仍能通过注入存储找回。
    const second = createAgentHarness({ ...deps, llm: { complete: async () => ({ type: 'final', output: '首页' }) } })
    await expect(second.resume({ sessionId: 's-19', callId: 'call-y', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '首页' })
  })

  it('接入 ContextManager 后历史被裁剪', async () => {
    const sessions = createMemorySessionStore()
    await sessions.save('s-20', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 2 }),
    })

    await harness.run({ sessionId: 's-20', input: '继续', context: {} })
    // 裁剪后的 2 条历史，加上前置的裁剪摘要 system 消息。
    expect(seen.filter((message) => message.role !== 'system')).toHaveLength(2)
  })

  it('裁剪摘要作为 system 消息发给模型', async () => {
    // 不注入摘要模型就不知道自己丢了上下文——它会以为看到的就是完整历史。
    const sessions = createMemorySessionStore()
    await sessions.save('s-23', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 2 }),
    })

    await harness.run({ sessionId: 's-23', input: '继续', context: {} })
    expect(seen[0]).toMatchObject({ role: 'system' })
    expect(String((seen[0] as { content: unknown }).content)).toContain('已裁剪')
  })

  it('未发生裁剪时不注入摘要消息', async () => {
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(),
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 10 }),
    })

    await harness.run({ sessionId: 's-24', input: '你好', context: {} })
    expect(seen.some((message) => message.role === 'system')).toBe(false)
  })

  it('声明输出协议时要求 JSON 并校验模型输出', async () => {
    const prompts = createPromptRegistry()
    prompts.register({
      name: 'assess',
      version: '1',
      prompt: '评估候选人',
      protocol: z.object({ shouldFavorite: z.boolean(), reason: z.string() }),
    })
    let sawJsonFlag = false
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          sawJsonFlag = request.responseFormatJson === true
          return { type: 'final', output: JSON.stringify({ shouldFavorite: true, reason: '匹配' }) }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 's-21', input: '评估', context: {} })).resolves.toEqual({
      type: 'final',
      output: { shouldFavorite: true, reason: '匹配' },
    })
    expect(sawJsonFlag).toBe(true)
  })

  it('模型输出不符合已声明协议时返回 LLM_OUTPUT_PROTOCOL_INVALID', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'assess', version: '1', prompt: '评估', protocol: z.object({ shouldFavorite: z.boolean() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: JSON.stringify({ shouldFavorite: '是' }) }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 's-22', input: '评估', context: {} })).rejects.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
  })
})

describe('按名选择提示词', () => {
  /** 注册两个提示词：第一个无协议（会成为默认），第二个带协议。 */
  function twoPrompts() {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'browser-automation', version: '1', prompt: '你在操作浏览器' })
    prompts.register({
      name: 'candidate-assessment',
      version: '1',
      prompt: '评估候选人',
      protocol: z.object({ decisions: z.array(z.object({ index: z.number() })) }),
    })
    return prompts
  }

  it('省略 promptName 时使用默认（首个注册）提示词', async () => {
    let seen: string | undefined
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.systemPrompt
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p1', input: 'hi', context: {} })
    expect(seen).toBe('你在操作浏览器')
  })

  it('指定 promptName 时使用该提示词', async () => {
    // 之前 harness 死取 getDefault()，第二个注册的提示词永远选不中。
    let seen: string | undefined
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.systemPrompt
          return { type: 'final', output: JSON.stringify({ decisions: [] }) }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p2', input: 'hi', context: {}, promptName: 'candidate-assessment' })
    expect(seen).toBe('评估候选人')
  })

  it('非默认提示词的输出协议能够生效', async () => {
    // 这是原缺陷的核心后果：candidate-assessment 的 protocol 此前完全不可达。
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: JSON.stringify({ decisions: 'not-an-array' }) }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await expect(
      harness.run({ sessionId: 's-p3', input: 'hi', context: {}, promptName: 'candidate-assessment' }),
    ).rejects.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
  })

  it('默认提示词无协议时不强制 JSON', async () => {
    let sawJsonFlag: boolean | undefined = true
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          sawJsonFlag = request.responseFormatJson
          return { type: 'final', output: '纯文本' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p4', input: 'hi', context: {} })
    expect(sawJsonFlag).toBeUndefined()
  })

  it('提示词未注册时返回 PROMPT_NOT_FOUND', async () => {
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: 'done' }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await expect(
      harness.run({ sessionId: 's-p5', input: 'hi', context: {}, promptName: 'nonexistent' }),
    ).rejects.toMatchObject({ code: 'PROMPT_NOT_FOUND' })
  })

  it('resume 沿用发起调用时的提示词', async () => {
    // 否则一次工具循环的前后两半会用不同提示词（甚至不同输出协议）。
    const prompts = twoPrompts()
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const seenPrompts: Array<string | undefined> = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenPrompts.push(request.systemPrompt)
          return seenPrompts.length === 1
            ? { type: 'tool_calls', calls: [{ callId: 'c1', toolName: 'browser_read_page', input: {} }] }
            : { type: 'final', output: JSON.stringify({ decisions: [] }) }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3, prompts,
    })

    await harness.run({ sessionId: 's-p6', input: 'hi', context: {}, promptName: 'candidate-assessment' })
    await harness.resume({ sessionId: 's-p6', callId: 'c1', output: { title: '首页' } })
    expect(seenPrompts).toEqual(['评估候选人', '评估候选人'])
  })
})
