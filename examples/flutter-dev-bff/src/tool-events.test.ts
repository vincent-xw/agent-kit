import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolDefinition } from '@agent-kit/core'
import { createEventBus } from './services/event-bus.js'
import type { FlutterEvent } from './services/event-bus.js'
import { instrumentTools, llmTraceToBus, truncate } from './tool-events.js'

function collect(bus: ReturnType<typeof createEventBus>): FlutterEvent[] {
  const events: FlutterEvent[] = []
  bus.subscribe((event) => events.push(event))
  return events
}

/** instrumentTools 返回数组，取首项。noUncheckedIndexedAccess 下需断言非空。 */
function wrapOne(definition: ToolDefinition, bus: ReturnType<typeof createEventBus>): ToolDefinition {
  const [wrapped] = instrumentTools([definition], bus)
  return wrapped!
}

const okTool: ToolDefinition = {
  name: 'demo_ok',
  execution: 'server',
  input: z.object({ q: z.string() }),
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
}

const signal = () => new AbortController().signal

describe('truncate', () => {
  it('短内容原样序列化', () => {
    expect(truncate({ a: 1 })).toBe('{"a":1}')
  })

  it('超长内容被截断并标记', () => {
    const result = truncate({ text: 'x'.repeat(5000) }, 100)

    expect(result.length).toBeLessThan(200)
    expect(result).toContain('truncated')
  })

  it('无法序列化的值不抛异常', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => truncate(circular)).not.toThrow()
  })
})

describe('instrumentTools', () => {
  it('执行成功时发出 tool_start 与 tool_end', async () => {
    const bus = createEventBus()
    const events = collect(bus)
    const wrapped = wrapOne(okTool, bus)

    await wrapped.execute!({ q: 'hi' }, { signal: signal() })

    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[0]!.name).toBe('demo_ok')
    expect(events[1]!.ok).toBe(true)
    expect(typeof events[1]!.durationMs).toBe('number')
  })

  it('透传原始返回值', async () => {
    const bus = createEventBus()
    const wrapped = wrapOne(okTool, bus)

    const result = await wrapped.execute!({ q: 'hi' }, { signal: signal() })

    expect(result).toEqual({ ok: true })
  })

  it('抛错时发出 ok:false 事件并原样抛出同一个异常', async () => {
    const boom = new Error('设备未连接')
    const failing: ToolDefinition = {
      name: 'demo_fail',
      execution: 'server',
      input: z.object({}),
      output: z.object({}),
      execute: async () => { throw boom },
    }
    const bus = createEventBus()
    const events = collect(bus)
    const wrapped = wrapOne(failing, bus)

    await expect(wrapped.execute!({}, { signal: signal() })).rejects.toBe(boom)

    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[1]!.ok).toBe(false)
    expect(String(events[1]!.error)).toContain('设备未连接')
  })

  it('没有 execute 的工具原样透传，不包装', () => {
    const remote: ToolDefinition = {
      name: 'demo_remote',
      execution: 'remote',
      input: z.object({}),
      output: z.object({}),
    }

    expect(wrapOne(remote, createEventBus())).toBe(remote)
  })

  it('保留 name、execution、schema 与 timeoutMs', () => {
    const timed: ToolDefinition = { ...okTool, timeoutMs: 12_345 }
    const wrapped = wrapOne(timed, createEventBus())

    expect(wrapped.name).toBe('demo_ok')
    expect(wrapped.execution).toBe('server')
    expect(wrapped.timeoutMs).toBe(12_345)
    expect(wrapped.input).toBe(timed.input)
    expect(wrapped.output).toBe(timed.output)
  })
})

describe('llmTraceToBus', () => {
  it('request 阶段只推摘要，不含 prompt 正文与消息内容', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({
      requestId: 'req-1',
      phase: 'request',
      durationMs: 0,
      body: {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '这是绝密系统提示词' },
          { role: 'user', content: '这是用户消息' },
        ],
        tools: [{ name: 't1' }, { name: 't2' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('llm_request')
    expect(events[0]!.model).toBe('deepseek-chat')
    expect(events[0]!.messageCount).toBe(2)
    expect(events[0]!.toolCount).toBe(2)

    const dump = JSON.stringify(events[0])
    expect(dump).not.toContain('绝密系统提示词')
    expect(dump).not.toContain('这是用户消息')
  })

  it('response 阶段只推摘要，不含模型原文', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({
      requestId: 'req-2',
      phase: 'response',
      durationMs: 1234,
      responseBody: {
        choices: [{ message: { content: '模型的完整回复正文' }, finish_reason: 'stop' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('llm_response')
    expect(events[0]!.durationMs).toBe(1234)
    expect(events[0]!.finishReason).toBe('stop')
    expect(JSON.stringify(events[0])).not.toContain('模型的完整回复正文')
  })

  it('error 阶段推错误事件', () => {
    const bus = createEventBus()
    const events = collect(bus)
    const trace = llmTraceToBus(bus)

    trace({ requestId: 'req-3', phase: 'error', durationMs: 50, error: new Error('连接超时') })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('llm_error')
    expect(String(events[0]!.error)).toContain('连接超时')
  })
})
