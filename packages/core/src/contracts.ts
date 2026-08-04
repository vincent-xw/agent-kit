import type { z } from 'zod'

/** 模型输出的工具调用。 */
export type ToolCall = { type: 'tool_call'; callId: string; toolName: string; input: unknown }

/** LLM 单次完成的输出：最终文本或工具调用。 */
export type LlmResult = { type: 'final'; output: unknown } | ToolCall

/** Harness 对外结果：最终输出、工具调用或需要远端 Tool Host 执行的挂起调用。 */
export type HarnessResult =
  | LlmResult
  | { type: 'pending_tool_call'; callId: string; toolName: string; input: unknown }

/** 会话消息：用户输入与工具结果，工具结果 content 为校验后的结构化输出。 */
export type SessionMessage = { role: 'user' | 'tool'; content: unknown }

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

/** 工具定义：Zod 输入/输出 Schema 与执行方式（服务端或远端 Tool Host）。 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  execution: 'server' | 'remote'
  input: z.ZodType<I>
  output: z.ZodType<O>
  execute?: (input: I) => Promise<O>
}
