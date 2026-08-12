import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import type { FlutterEvent } from './event-bus.js'

describe('EventBus', () => {
  it('seq 从 1 开始单调递增，并自动补 ts', () => {
    const bus = createEventBus()
    const received: FlutterEvent[] = []
    bus.subscribe((event) => received.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })
    bus.emit({ type: 'tool_end', name: 'a' })

    expect(received.map((e) => e.seq)).toEqual([1, 2])
    expect(received[0]!.type).toBe('tool_start')
    expect(typeof received[0]!.ts).toBe('number')
  })

  it('退订后不再收到事件', () => {
    const bus = createEventBus()
    const received: FlutterEvent[] = []
    const unsubscribe = bus.subscribe((event) => received.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })
    unsubscribe()
    bus.emit({ type: 'tool_start', name: 'b' })

    expect(received).toHaveLength(1)
  })

  it('多个订阅者都收到同一事件', () => {
    const bus = createEventBus()
    const first: FlutterEvent[] = []
    const second: FlutterEvent[] = []
    bus.subscribe((event) => first.push(event))
    bus.subscribe((event) => second.push(event))

    bus.emit({ type: 'tool_start', name: 'a' })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it('环形缓冲不超过上限', () => {
    const bus = createEventBus({ bufferSize: 3 })
    for (let i = 0; i < 10; i += 1) bus.emit({ type: 'tool_start', index: i })

    const replayed: FlutterEvent[] = []
    bus.subscribe((event) => replayed.push(event), 0)

    expect(replayed).toHaveLength(3)
    expect(replayed.map((e) => e.seq)).toEqual([8, 9, 10])
  })

  it('subscribe 传 fromSeq 时只重放更新的事件', () => {
    const bus = createEventBus()
    bus.emit({ type: 'tool_start', name: 'a' })
    bus.emit({ type: 'tool_start', name: 'b' })
    bus.emit({ type: 'tool_start', name: 'c' })

    const replayed: FlutterEvent[] = []
    bus.subscribe((event) => replayed.push(event), 2)

    expect(replayed.map((e) => e.seq)).toEqual([3])
  })

  it('不传 fromSeq 时不重放历史，只收后续事件', () => {
    const bus = createEventBus()
    bus.emit({ type: 'tool_start', name: 'old' })

    const received: FlutterEvent[] = []
    bus.subscribe((event) => received.push(event))
    bus.emit({ type: 'tool_start', name: 'new' })

    expect(received).toHaveLength(1)
    expect(received[0]!.name).toBe('new')
  })
})
