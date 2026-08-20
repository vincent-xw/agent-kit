import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@agent-kit/core'
import { createHostToolDefinitions, type HostToolServices } from './host-tools.js'

type Exec = (i: unknown, c: unknown) => Promise<Record<string, unknown>>
const execOf = (t: ToolDefinition): Exec => t.execute as unknown as Exec

const dir = join(tmpdir(), `ak-host-${Date.now()}`)

function svcs(): HostToolServices {
  return { workspaceRoot: () => dir }
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

describe('host 工具', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello')
    mkdirSync(join(dir, 'sub'))
  })

  it('host_file_list 列出目录条目', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_file_list'))({ path: '.' }, {})
    expect(out.ok).toBe(true)
    const entries = out.entries as Array<{ name: string; type: string }>
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
    expect(entries.find((e) => e.name === 'a.txt')?.type).toBe('file')
  })

  it('host_file_list 越权被拒', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_file_list'))({ path: '../' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/outside workspace/)
  })

  it('host_file_read 读文本', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_file_read'))({ path: 'a.txt' }, {})
    expect(out).toMatchObject({ ok: true, content: 'hello' })
  })

  it('host_file_write 越权被拒', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_file_write'))({ path: '../evil', content: 'x' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/outside workspace/)
  })

  it('host_file_write 写入成功', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_file_write'))({ path: 'b.txt', content: 'hi' }, {})
    expect(out.ok).toBe(true)
  })

  it('host_exec 执行返回输出', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_exec'))({ command: 'printf hello' }, {})
    expect(String(out.stdout)).toContain('hello')
  })

  it('host_notify 返回 ok', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_notify'))({ title: 't', message: 'm' }, {})
    expect(out).toMatchObject({ ok: true })
  })

  it('web_fetch 本地回环被拦截', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'web_fetch'))({ url: 'http://127.0.0.1/' }, {})
    expect(out.blocked).toBe(true)
  })

  it('host_clipboard read', async () => {
    const out = await execOf(byName(createHostToolDefinitions(svcs()), 'host_clipboard'))({ action: 'read' }, {})
    expect('ok' in out).toBe(true)
  })
})