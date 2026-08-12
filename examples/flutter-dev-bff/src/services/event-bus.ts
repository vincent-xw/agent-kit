export interface FlutterEvent {
  seq: number
  ts: number
  type: string
  [key: string]: unknown
}

export interface EventBus {
  emit(event: { type: string; [key: string]: unknown }): void
  /** fromSeq 有值时先重放缓冲中 seq 大于它的事件，再接收后续事件。 */
  subscribe(listener: (event: FlutterEvent) => void, fromSeq?: number): () => void
}

export function createEventBus(options: { bufferSize?: number } = {}): EventBus {
  const bufferSize = options.bufferSize ?? 200
  const buffer: FlutterEvent[] = []
  const listeners = new Set<(event: FlutterEvent) => void>()
  let seq = 0

  return {
    emit(event) {
      seq += 1
      const full: FlutterEvent = { ...event, seq, ts: Date.now() }
      buffer.push(full)
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
      for (const listener of listeners) listener(full)
    },
    subscribe(listener, fromSeq) {
      if (fromSeq !== undefined) {
        for (const event of buffer) {
          if (event.seq > fromSeq) listener(event)
        }
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
