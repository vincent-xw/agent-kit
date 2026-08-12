import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolDefinition } from '@agent-kit/core'
import { createEventBus } from './services/event-bus.js'
import type { FlutterEvent } from './services/event-bus.js'
import { instrumentTools, truncate } from './tool-events.js'

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
