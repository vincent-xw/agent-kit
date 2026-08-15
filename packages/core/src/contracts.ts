import type { z } from 'zod'

/** 模型输出的单个工具调用。callId 用于回填时关联，并作为 OpenAI 的 tool_call_id 回传。 */
export type ToolCall = { callId: string; toolName: string; input: unknown }

/**
 * LLM 单次完成的输出：最终文本，或本轮全部工具调用。
 * 复数形态是必需的——模型可以在一轮内发起多个调用，只取第一个会静默丢弃其余调用。
 */
export type LlmResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'tool_calls'; calls: ToolCall[]; reasoning?: string }

/** Harness 对外结果：最终输出，或需要远端 Tool Host 执行的挂起调用集合。 */
export type HarnessResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'pending_tool_calls'; calls: Array<{ callId: string; toolName: string; input: unknown }> }
  | { type: 'step_done' }

/**
 * 会话消息。assistant 角色是必需的：缺少它模型看不到自己的上一轮输出与已发起的工具调用，
 * 多轮对话实际不成立。toolCalls 仅在 assistant 消息上出现；callId 仅在 tool 消息上出现。
 */
export type SessionMessage =
  | { role: 'user'; content: unknown }
  | { role: 'assistant'; content: unknown; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: unknown; callId: string; toolName?: string }
  /** 运行期注入的系统消息（例如上下文裁剪摘要）。不落库，只在发给模型时前置。 */
  | { role: 'system'; content: unknown }

/** LLM 密钥配置，适配器从受信任来源读取后注入。 */
export interface LlmSecret {
  apiKey: string
  baseUrl: string
  model: string
}

/** 密钥提供者，浏览器/H5 侧永远不应有可调用的实现。 */
export interface SecretProvider {
  get(): Promise<LlmSecret>
}

/** 会话存储，按 sessionId 读写消息。 */
export interface SessionStore {
  load(sessionId: string): SessionMessage[] | Promise<SessionMessage[]>
  save(sessionId: string, messages: SessionMessage[]): void | Promise<void>
}

/** 挂起的远端工具调用记录，用于 resume 时校验 callId 归属。 */
export interface PendingCall {
  sessionId: string
  toolName: string
  /**
   * 发起本次调用时所用的提示词名称。
   * 必须随挂起状态一起保存：resume 要用同一个提示词继续，否则一次工具循环的
   * 前后两半会用不同提示词（甚至不同输出协议），行为将不可预测。
   */
  promptName?: string
}

/**
 * 挂起调用存储。抽成接口是因为进程内 Map 在两种场景都会丢：
 * BFF 进程重启，以及 MV3 Service Worker 空闲挂起。宿主可注入持久化实现。
 */
export interface PendingCallStore {
  get(callId: string): PendingCall | undefined | Promise<PendingCall | undefined>
  set(callId: string, call: PendingCall): void | Promise<void>
  delete(callId: string): void | Promise<void>
}

/** 审计事件只含非敏感字段：requestId、模型、耗时、HTTP 状态、工具名与错误码。 */
export interface AuditEvent {
  requestId: string
  model?: string
  durationMs: number
  httpStatus?: number
  toolName?: string
  errorCode?: string
}

/** 审计记录器接口，禁止记录密钥、Prompt 正文、模型原文或业务上下文。 */
export interface AuditLogger {
  log(event: AuditEvent): void | Promise<void>
}

/** 工具执行上下文：透传取消信号，使长时间运行的工具可被中止。 */
export interface ToolExecutionContext {
  signal: AbortSignal
}

/** 工具定义：Zod 输入/输出 Schema 与执行方式（服务端或远端 Tool Host）。 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  execution: 'server' | 'remote'
  /** 供模型理解用途的说明，会随 JSON Schema 一并发给模型。 */
  description?: string
  input: z.ZodType<I>
  output: z.ZodType<O>
  /** 单次执行超时毫秒数；未设置时使用 harness 的默认值。 */
  timeoutMs?: number
  execute?: (input: I, context: ToolExecutionContext) => Promise<O>
}

/** 发送给模型的工具声明，input schema 已转换为 JSON Schema。 */
export interface ToolSchema {
  name: string
  description?: string
  parameters: Record<string, unknown>
}
