import { z } from 'zod'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, writeFile, appendFile, stat, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ToolDefinition } from '@agent-kit/core'
import { assertInsideRoot } from './path-safety.js'

const execAsync = promisify(exec)

export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface HostToolServices {
  /** 运行时读取的当前工作区根目录（可在 UI 修改）。 */
  workspaceRoot: () => string
}

const TEXT_MAX = 200_000
const EXEC_OUT_MAX = 64_000

/** 强制子进程 UTF-8 本地化，避免剪贴板/命令输出被按本地默认编码解码成乱码。 */
const UTF8_ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true
  if (hostname.startsWith('127.')) return true
  if (hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
}

async function statSafe(p: string) {
  try { return await stat(p) } catch { return undefined }
}

export function createHostToolDefinitions(svc: HostToolServices): ToolDefinition[] {
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
      description: '写入工作区根内文件（默认覆盖，可追加）。写入工作区外的路径会被拒绝。是否执行需由你判断并先用 user_confirm 请求用户批准（除非受信任 host 模式已开启）。',
      input: z.object({ path: z.string(), content: z.string(), mode: z.enum(['overwrite', 'append', 'create']).optional() }),
      output: z.object({ ok: z.boolean(), bytes: z.number().optional(), error: z.string().optional() }),
      timeoutMs: 30_000,
      async execute(raw) {
        const { path, content, mode = 'overwrite' } = raw as { path: string; content: string; mode?: string }
        let abs: string
        try {
          abs = assertInsideRoot(svc.workspaceRoot(), path)
        } catch (error) {
          return { ok: false, error: msg(error) }
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
      description: '在用户电脑上执行一条命令并截取输出。是否执行需由你判断并先用 user_confirm 请求用户批准（除非受信任 host 模式已开启）。',
      input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120_000).optional() }),
      output: z.object({ ok: z.boolean(), stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().optional(), timedOut: z.boolean().optional(), error: z.string().optional() }),
      timeoutMs: 125_000,
      async execute(raw) {
        const { command, cwd, timeoutMs } = raw as { command: string; cwd?: string; timeoutMs?: number }
        let cwdAbs: string | undefined
        if (cwd) {
          try { cwdAbs = assertInsideRoot(svc.workspaceRoot(), cwd) } catch { return { ok: false, error: 'cwd outside workspace' } }
        }
        try {
          const out = await execAsync(command, {
            cwd: cwdAbs ?? svc.workspaceRoot(),
            timeout: timeoutMs ?? 60_000,
            maxBuffer: EXEC_OUT_MAX * 2,
            shell: '/bin/sh',
            env: UTF8_ENV,
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
      description: '读写用户电脑剪贴板。读写是否执行都需你判断并先用 user_confirm 请求用户批准（除非受信任 host 模式已开启）。',
      input: z.object({ action: z.enum(['read', 'write']), text: z.string().optional() }),
      output: z.object({ ok: z.boolean(), text: z.string().optional(), error: z.string().optional() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { action, text } = raw as { action: 'read' | 'write'; text?: string }
        const copyCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard'
        const pasteCmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o'
        if (action === 'read') {
          try {
            const { stdout } = await execAsync(pasteCmd, { shell: '/bin/sh', encoding: 'buffer', maxBuffer: 1024 * 1024, env: UTF8_ENV })
            const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
            // 剪贴板可能是 UTF-8，也可能是 GBK/GB18030；UTF-8 解码出现替换符时回退到 GB18030。
            const utf8 = buf.toString('utf8')
            const text = utf8.includes('�') ? new TextDecoder('gb18030').decode(buf) : utf8
            return { ok: true, text: text.slice(0, TEXT_MAX) }
          } catch {
            return { ok: false, error: `${process.platform === 'darwin' ? 'pbpaste' : 'xclip'} 不可用` }
          }
        }
        try {
          await execAsync(`printf %s ${JSON.stringify(text ?? '')} | ${copyCmd}`, { shell: '/bin/sh', env: UTF8_ENV })
          // 读回校验，确保真的写入（某些沙箱/无 GUI 会话里 pbcopy 会静默失败）
          const { stdout } = await execAsync(pasteCmd, { shell: '/bin/sh', encoding: 'buffer', maxBuffer: 1024 * 1024, env: UTF8_ENV })
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
          const utf8 = buf.toString('utf8')
          const got = (utf8.includes('') ? new TextDecoder('gb18030').decode(buf) : utf8).trim()
          const want = (text ?? '').trim()
          if (got !== want) return { ok: false, error: '写入后校验不一致——剪贴板未真正更新（可能是沙箱/无 GUI 会话限制）' }
          return { ok: true }
        } catch (error) {
          return { ok: false, error: msg(error) }
        }
      },
    },
  ]
}