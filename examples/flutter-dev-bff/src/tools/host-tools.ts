import { z } from 'zod'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, writeFile, appendFile, stat, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ToolDefinition } from '@agent-kit/core'
import { assertInsideRoot } from './path-safety.js'
import type { AskService } from '../services/ask-service.js'
import type { HostPolicyService } from '../services/host-policy.js'

const execAsync = promisify(exec)

export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface HostToolServices {
  workspaceRoot: () => string
  ask: AskService
  policy: HostPolicyService
}

const TEXT_MAX = 200_000
const EXEC_OUT_MAX = 64_000

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true
  if (hostname.startsWith('127.')) return true
  if (hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
}

/** 未受信任时走 user_confirm 审批；返回是否放行。callId 为工具自身调用。 */
async function confirmIfNeeded(
  svc: HostToolServices,
  sessionId: string,
  callId: string,
  question: string,
): Promise<boolean> {
  if (svc.policy.isTrusted(sessionId)) return true
  const answer = await svc.ask.awaitAnswer({
    sessionId,
    callId,
    kind: 'approval',
    question,
    options: ['允许', '拒绝'],
    select: 'single',
  })
  return answer === '允许'
}

async function statSafe(p: string) {
  try { return await stat(p) } catch { return undefined }
}

export function createHostToolDefinitions(svc: HostToolServices): ToolDefinition[] {
  const hostCtx = (c: unknown) => ({
    sessionId: ((c ?? {}) as { sessionId?: string }).sessionId ?? '',
    callId: ((c ?? {}) as { callId?: string }).callId ?? '',
  })

  return [
    {
      name: 'host_file_list',
      execution: 'server',
      description: '列出工作区根目录内某个目录下的条目（文件/子目录）。目录须在工作区根内。',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean(), entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'dir']), size: z.number().optional(), modifiedAt: z.number().optional() })).optional(), error: z.string().optional() }),
      timeoutMs: 15_000,
      async execute(raw) {
        try {
          const dir0 = assertInsideRoot(svc.workspaceRoot(), (raw as { path: string }).path)
          const entries = await readdir(dir0, { withFileTypes: true })
          const out = await Promise.all(entries.map(async (e) => {
            const st = await statSafe(join(dir0, e.name))
            return {
              name: e.name,
              type: e.isDirectory() ? 'dir' as const : 'file' as const,
              ...(st?.size != null ? { size: st.size } : {}),
              ...(st?.mtimeMs != null ? { modifiedAt: st.mtimeMs } : {}),
            }
          }))
          return { ok: true, entries: out }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_file_read',
      execution: 'server',
      description: '读取工作区根内文本文件，超长会截断。二进制文件不读。',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean(), content: z.string().optional(), truncated: z.boolean().optional(), error: z.string().optional() }),
      timeoutMs: 15_000,
      async execute(raw) {
        try {
          const abs = assertInsideRoot(svc.workspaceRoot(), (raw as { path: string }).path)
          const buf = await readFile(abs)
          if (buf.includes(0)) return { ok: false, error: '是二进制文件，无法作为文本读取' }
          const text = buf.toString('utf8')
          return { ok: true, content: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_file_write',
      execution: 'server',
      description: '写入工作区根内文件（默认覆盖，可追加）。写入前通常需要用户审批。',
      input: z.object({ path: z.string(), content: z.string(), mode: z.enum(['overwrite', 'append', 'create']).optional() }),
      output: z.object({ ok: z.boolean(), bytes: z.number().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 30_000,
      async execute(raw, context) {
        const { path, content, mode = 'overwrite' } = raw as { path: string; content: string; mode?: string }
        let abs: string
        try {
          abs = assertInsideRoot(svc.workspaceRoot(), path)
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, `允许写入文件 ${abs} 吗？`)) {
          return { ok: false, denied: true }
        }
        try {
          if (mode === 'append') {
            await appendFile(abs, content, 'utf8')
          } else {
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, content, 'utf8')
          }
          return { ok: true, bytes: Buffer.byteLength(content) }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_exec',
      execution: 'server',
      description: '在用户电脑上执行一条命令并截取输出。命令执行前通常需要审批。',
      input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120_000).optional() }),
      output: z.object({ ok: z.boolean(), stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().optional(), timedOut: z.boolean().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 125_000,
      async execute(raw, context) {
        const { command, cwd, timeoutMs } = raw as { command: string; cwd?: string; timeoutMs?: number }
        let cwdAbs: string | undefined
        if (cwd) {
          try { cwdAbs = assertInsideRoot(svc.workspaceRoot(), cwd) } catch { return { ok: false, error: 'cwd outside workspace' } }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, `允许执行命令：${command.slice(0, 200)}？`)) {
          return { ok: false, denied: true }
        }
        try {
          const out = await execAsync(command, {
            cwd: cwdAbs ?? svc.workspaceRoot(),
            timeout: timeoutMs ?? 60_000,
            maxBuffer: EXEC_OUT_MAX * 2,
            shell: '/bin/sh',
          })
          return { ok: true, stdout: String(out.stdout ?? '').slice(0, EXEC_OUT_MAX), stderr: String(out.stderr ?? '').slice(0, EXEC_OUT_MAX), exitCode: 0 }
        } catch (error) {
          const e = error as { stdout?: unknown; stderr?: unknown; killed?: boolean; code?: unknown }
          return {
            ok: false,
            stdout: String(e.stdout ?? '').slice(0, EXEC_OUT_MAX),
            stderr: String(e.stderr ?? '').slice(0, EXEC_OUT_MAX),
            exitCode: typeof e.code === 'number' ? e.code : undefined,
            timedOut: e.killed === true,
            error: msg(error),
          }
        }
      },
    },
    {
      name: 'host_notify',
      execution: 'server',
      description: '发一条桌面通知（macOS 或 Linux）。',
      input: z.object({ title: z.string(), message: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      timeoutMs: 5000,
      async execute(raw) {
        const { title, message = '' } = raw as { title: string; message?: string }
        try {
          if (process.platform === 'darwin') {
            const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
            await execAsync(`osascript -e ${JSON.stringify(script)}`, { shell: '/bin/sh' })
          } else {
            await execAsync(`notify-send ${JSON.stringify(title)} ${JSON.stringify(message)}`, { shell: '/bin/sh' })
          }
        } catch { /* 静默降级 */ }
        return { ok: true }
      },
    },
    {
      name: 'web_fetch',
      execution: 'server',
      description: '抓取一个 http(s) URL 的文本内容（只读）。默认拦截本地回环与保留段；可用 HOST_FETCH_ALLOWED_HOSTS 白名单。',
      input: z.object({ url: z.string() }),
      output: z.object({ ok: z.boolean(), status: z.number().optional(), text: z.string().optional(), blocked: z.boolean().optional(), error: z.string().optional() }),
      timeoutMs: 20_000,
      async execute(raw) {
        const url = (raw as { url: string }).url
        let parsed: URL
        try { parsed = new URL(url) } catch { return { ok: false, error: 'url 不合法' } }
        if (!['http:', 'https:'].includes(parsed.protocol) || isLocalHost(parsed.hostname)) {
          return { ok: false, blocked: true }
        }
        const allowed = (process.env.HOST_FETCH_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (allowed.length > 0 && !allowed.includes(parsed.hostname)) {
          return { ok: false, blocked: true }
        }
        try {
          const res = await fetch(parsed, { signal: AbortSignal.timeout(15_000) })
          const text = await res.text()
          return { ok: true, status: res.status, text: text.slice(0, TEXT_MAX) }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
    {
      name: 'host_clipboard',
      execution: 'server',
      description: '读写用户电脑剪贴板。read 直接读；write 需审批。',
      input: z.object({ action: z.enum(['read', 'write']), text: z.string().optional() }),
      output: z.object({ ok: z.boolean(), text: z.string().optional(), error: z.string().optional(), denied: z.boolean().optional() }),
      timeoutMs: 10_000,
      async execute(raw, context) {
        const { action, text } = raw as { action: 'read' | 'write'; text?: string }
        const copyCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard'
        const pasteCmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o'
        if (action === 'read') {
          try {
            const { stdout } = await execAsync(pasteCmd, { shell: '/bin/sh', maxBuffer: 1024 * 1024 })
            return { ok: true, text: String(stdout ?? '').slice(0, TEXT_MAX) }
          } catch {
            return { ok: false, error: `${process.platform === 'darwin' ? 'pbpaste' : 'xclip'} 不可用` }
          }
        }
        const { sessionId, callId } = hostCtx(context)
        if (!await confirmIfNeeded(svc, sessionId, callId, '允许写入剪贴板吗？')) return { ok: false, denied: true }
        try {
          await execAsync(`printf %s ${JSON.stringify(text ?? '')} | ${copyCmd}`, { shell: '/bin/sh' })
          return { ok: true }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
  ]
}