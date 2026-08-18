/** BFF 返回的数据类型，与 server.ts 的 JSON 契约一致。 */

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: unknown
  callId?: string
  toolName?: string
  toolCalls?: Array<{ callId: string; toolName: string; input: unknown }>
}

export type ToolMessage = SessionMessage & { role: 'tool'; callId: string; toolName: string }

export interface SessionMeta {
  id: string
  title: string
  titleGenerated: boolean
  createdAt: string
  updatedAt: string
}

export interface Skill {
  id: string
  name: string
  firstInstruction: string
  finalReplySummary: string
  createdAt: string
}

export interface StoredFile {
  id: string
  filename: string
  size: number
  createdAt: string
  format: string
  isImage: boolean
  width?: number
  height?: number
}

export interface TaskPlan {
  feasible: boolean
  confidence: 'high' | 'medium' | 'low'
  summary: string
  steps: Array<{ action: string; tool: string; write: boolean; note?: string }>
  risks: string[]
  cannotDo: string[]
}

export interface AgentRunResult {
  type: 'final'
  output: unknown
  reasoning?: string
}

export interface ToolStep {
  step: number
  toolName: string
  input: unknown
  output: unknown
}

export interface ConversationTurn {
  role: 'user' | 'agent' | 'error'
  text: string
  steps: ToolStep[]
  files: StoredFile[]
}

export interface ExecutorStatus {
  online: boolean
  tabUrl?: string
  tabTitle?: string
}