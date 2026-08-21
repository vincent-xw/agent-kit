import type { SessionMessage } from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmTraceEvent } from './llm-client.js'
import { compressMessages, type CompressResult, type Summarizer } from './context-compressor.js'
import { applyUsageCorrection, estimateMessages } from './token-counter.js'

export interface ContextStatus {
  model: string
  limit: number
  used: number
  remaining: number
  ratio: number
  compressedCount: number
  lastUpdatedAt?: string
}

export interface TokenContextManagerOptions {
  model: string
  limit: number
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
  summarizer?: Summarizer
}

export interface TokenContextManager extends ContextManager {
  onLlmTrace(event: LlmTraceEvent): void
  getStatus(sessionId: string): ContextStatus
  sync(sessionId: string, messages: SessionMessage[]): void
  forceCompress(sessionId: string, messages: SessionMessage[]): Promise<SessionMessage[]>
  setSummarizer(summarizer: Summarizer): void
}

interface SessionState {
  raw: SessionMessage[]
  trimmed: SessionMessage[]
  summary?: string
  compressedCount: number
  lastUsageTotal?: number
  lastUpdatedAt?: string
}

export function createTokenContextManager(options: TokenContextManagerOptions): TokenContextManager {
  const sessions = new Map<string, SessionState>()
  const high = options.highWatermark ?? 0.8
  const low = options.lowWatermark ?? 0.5
  const preserve = options.preserveRecentUnits ?? 2

  function getState(sessionId: string): SessionState {
    return sessions.get(sessionId) ?? { raw: [], trimmed: [], compressedCount: 0 }
  }

  function setState(sessionId: string, state: SessionState) {
    sessions.set(sessionId, state)
  }

  function computeUsed(state: SessionState): number {
    return applyUsageCorrection(estimateMessages(state.trimmed), state.lastUsageTotal ? { total_tokens: state.lastUsageTotal } : undefined)
  }

  function buildStatus(sessionId: string): ContextStatus {
    const state = getState(sessionId)
    const used = computeUsed(state)
    const limit = options.limit
    const status: ContextStatus = {
      model: options.model,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      ratio: limit > 0 ? used / limit : 0,
      compressedCount: state.compressedCount,
    }
    if (state.lastUpdatedAt !== undefined) status.lastUpdatedAt = state.lastUpdatedAt
    return status
  }

  async function runCompress(messages: SessionMessage[]): Promise<CompressResult> {
    return compressMessages(
      messages,
      { limit: options.limit, highWatermark: high, lowWatermark: low, preserveRecentUnits: preserve },
      options.summarizer,
    )
  }

  return {
    async save(sessionId, messages) {
      const compressed = await runCompress(messages)
      const state: SessionState = {
        ...getState(sessionId),
        raw: messages,
        trimmed: compressed.messages,
        compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      if (compressed.summary !== undefined) state.summary = compressed.summary
      setState(sessionId, state)
    },
    async load(sessionId) {
      return getState(sessionId).trimmed
    },
    async append(sessionId, message) {
      const state = getState(sessionId)
      await this.save(sessionId, [...state.raw, message])
    },
    async getSummary(sessionId) {
      return getState(sessionId).summary
    },
    onLlmTrace(event) {
      if (!event.sessionId) return
      if (event.totalTokens && event.totalTokens > 0) {
        const state = getState(event.sessionId)
        state.lastUsageTotal = event.totalTokens
        state.lastUpdatedAt = new Date().toISOString()
        setState(event.sessionId, state)
      }
    },
    getStatus(sessionId) {
      return buildStatus(sessionId)
    },
    sync(sessionId, messages) {
      const state = getState(sessionId)
      state.raw = messages
      state.trimmed = messages
      state.lastUpdatedAt = new Date().toISOString()
      setState(sessionId, state)
    },
    async forceCompress(sessionId, messages) {
      const compressed = await runCompress(messages)
      const state: SessionState = {
        ...getState(sessionId),
        raw: compressed.messages,
        trimmed: compressed.messages,
        compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      if (compressed.summary !== undefined) state.summary = compressed.summary
      setState(sessionId, state)
      return compressed.messages
    },
    setSummarizer(summarizer) {
      options.summarizer = summarizer
    },
  }
}
