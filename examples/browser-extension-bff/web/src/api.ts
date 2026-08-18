import type {
  AgentRunResult,
  ExecutorStatus,
  SessionMessage,
  SessionMeta,
  Skill,
  StoredFile,
} from './types'

/**
 * BFF API 客户端。
 *
 * 统一管理鉴权 token、请求、错误处理、SSE 长连接。
 * Base URL 默认解析为当前站点 origin（iframe 场景就是 BFF 自己），
 * 开发期可通过环境变量 VITE_BFF_BASE 覆盖。
 */

export const bffBase = import.meta.env.VITE_BFF_BASE || location.origin

export function getToken(): string {
  return new URLSearchParams(location.search).get('token') || localStorage.getItem('bff-token') || ''
}

/** 会话 id 持久化在 localStorage，供刷新后恢复（切换会话同理）。 */
export function getSessionId(): string {
  return localStorage.getItem('bff-session-id') || crypto.randomUUID()
}
export function setSessionId(id: string): void {
  localStorage.setItem('bff-session-id', id)
}

export class BffError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'BffError'
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }
}

async function handle<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { code?: string; message?: string }
    throw new BffError(body.message || `HTTP ${resp.status}`, body.code, resp.status)
  }
  return resp.json() as Promise<T>
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${bffBase}${path}`, { headers: authHeaders() })
  return handle<T>(resp)
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${bffBase}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  })
  return handle<T>(resp)
}

async function del<T>(path: string): Promise<T> {
  const resp = await fetch(`${bffBase}${path}`, { headers: authHeaders(), method: 'DELETE' })
  return handle<T>(resp)
}

/** 发起 agent 运行。BFF 侧驱动工具循环并返回 final 结果。 */
export function runAgent(input: string, context: Record<string, unknown>, promptName: string, skipTools: boolean, signal?: AbortSignal): Promise<AgentRunResult> {
  return post<AgentRunResult>(`/v1/agent/sessions/${encodeURIComponent(getSessionId())}/run`, {
    input,
    context,
    promptName,
    skipTools,
    stepMode: true,
  }, signal)
}

export async function loadMessages(): Promise<SessionMessage[]> {
  const data = await get<{ messages: SessionMessage[] }>(`/api/sessions/${encodeURIComponent(getSessionId())}/messages`)
  return data.messages
}

export async function loadSessions(): Promise<SessionMeta[]> {
  const data = await get<{ sessions: SessionMeta[] }>('/api/sessions')
  return data.sessions
}

export async function deleteSession(id: string): Promise<void> {
  await del(`/api/sessions/${encodeURIComponent(id)}`)
  // 同时清掉 storage 里的会话历史记录
}

export async function loadSkills(): Promise<Skill[]> {
  const data = await get<{ skills: Skill[] }>('/api/skills')
  return data.skills
}

export async function saveSkill(name: string, firstInstruction: string, finalReplySummary: string): Promise<void> {
  await post('/api/skills', { name, firstInstruction, finalReplySummary })
}

export async function deleteSkill(id: string): Promise<void> {
  await del(`/api/skills/${encodeURIComponent(id)}`)
}

export async function loadFiles(): Promise<StoredFile[]> {
  const data = await get<{ files: StoredFile[] }>('/api/files')
  return data.files
}

export function fileDownloadUrl(id: string): string {
  return `${bffBase}/api/files/${encodeURIComponent(id)}/download?token=${encodeURIComponent(getToken())}`
}

export async function deleteFile(id: string): Promise<void> {
  await fetch(`${bffBase}/api/files/${encodeURIComponent(id)}?token=${encodeURIComponent(getToken())}`, { method: 'DELETE' })
}

export async function uploadFiles(files: File[]): Promise<void> {
  const formData = new FormData()
  for (const file of files) formData.append('file', file)
  await fetch(`${bffBase}/api/files/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken()}` },
    body: formData,
  })
}

/**
 * SSE 事件流连接。
 * onToolStart / onToolEnd / onExecutorStatus / onSessionEnded 为回调。
 */
export function connectEventSource(onEvent: (type: string, data: Record<string, unknown>) => void): () => void {
  const token = getToken()
  if (!token) return () => {}
  const es = new EventSource(`${bffBase}/api/events?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(getSessionId())}`)
  const types = ['tool_start', 'tool_end', 'step', 'done', 'error', 'executor_status']
  const handlers: Record<string, (e: MessageEvent) => void> = {}
  for (const t of types) {
    handlers[t] = (e) => {
      try { onEvent(t, JSON.parse(e.data)) } catch { /* ignore malformed */ }
    }
    es.addEventListener(t, handlers[t])
  }
  return () => {
    for (const t of types) es.removeEventListener(t, handlers[t])
    es.close()
  }
}