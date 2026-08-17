/** 事件总线：工具事件 → SSE 推送。与 flutter-dev-bff 的 EventBus 设计一致。 */

export interface BusEvent {
  type: 'tool_start' | 'tool_end' | 'step' | 'done' | 'error' | 'executor_status'
  data: Record<string, unknown>
}

export function createEventBus() {
  const listeners = new Set<(event: BusEvent) => void>()
  const history: BusEvent[] = []
  const MAX_HISTORY = 200

  return {
    emit(event: BusEvent) {
      history.push(event)
      if (history.length > MAX_HISTORY) history.shift()
      for (const listener of listeners) listener(event)
    },
    subscribe(listener: (event: BusEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getHistory() {
      return [...history]
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>