import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@agent-kit/core'
import { createHostToolDefinitions, type HostToolServices } from './host-tools.js'
import { createAskService } from '../services/ask-service.js'
import { createHostPolicyService } from '../services/host-policy.js'

type Exec = (i: unknown, c: unknown) => Promise<Record<string, unknown>>
const execOf = (t: ToolDefinition): Exec => t.execute as unknown as Exec

function makeSvcs(root: string, opts: { trusted?: boolean } = {}) {
  const ask = createAskService({ emit: () => {} })
  const policy = createHostPolicyService()
  if (opts.trusted) policy.setTrusted('flutter-dev:s1', true)
  const svcs: HostToolServices = { workspaceRoot: root, ask, policy }
  return { svcs, ask }
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

/** 启动 execute（不 await），随后以 answer 回填 ask，返回最终输出。 */
async function runApproved(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  ask: ReturnType<typeof createAskService>,
  callId: string,
  answer: string,
): Promise<Record<string, unknown>> {
  const p = execOf(byName(tools, name))(input, { sessionId: 'flutter-dev:s1', callId })
  await new Promise((r) => setTimeout(r, 5))
  ask.resolve('flutter-dev:s1', callId, answer)
  return p
}

const dir = join(tmpdir(), `ak-host-${Date.now()}`)

describe('host 工具', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello')
    mkdirSync(join(dir, 'sub'))
  })

  it('host_file_list 列出目录条目', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_file_list'))({ path: '.' }, {})
    expect(out.ok).toBe(true)
    const entries = out.entries as Array<{ name: string; type: string }>
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
    expect(entries.find((e) => e.name === 'a.txt')?.type).toBe('file')
  })

  it('host_file_list 越权被拒', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_file_list'))({ path: '../' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/outside workspace/)
  })

  it('host_file_read 读文本', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_file_read'))({ path: 'a.txt' }, {})
    expect(out).toMatchObject({ ok: true, content: 'hello' })
  })

  it('host_file_write 未受信任需审批，拒绝返回 denied', async () => {
    const { svcs, ask } = makeSvcs(dir)
    const out = await runApproved(createHostToolDefinitions(svcs), 'host_file_write', { path: 'b.txt', content: 'x' }, ask, 'c1', '拒绝')
    expect(out.denied).toBe(true)
  })

  it('host_file_write 受信任后写入', async () => {
    const { svcs } = makeSvcs(dir, { trusted: true })
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_file_write'))({ path: 'b.txt', content: 'hi' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(out.ok).toBe(true)
  })

  it('host_file_write 越权被拒', async () => {
    const { svcs } = makeSvcs(dir, { trusted: true })
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_file_write'))({ path: '../evil', content: 'x' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/outside workspace/)
  })

  it('host_exec 受信任时执行返回输出', async () => {
    const { svcs } = makeSvcs(dir, { trusted: true })
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_exec'))({ command: 'printf hello' }, { sessionId: 'flutter-dev:s1', callId: 'c1' })
    expect(String(out.stdout)).toContain('hello')
  })

  it('host_exec 未受信任返回 denied', async () => {
    const { svcs, ask } = makeSvcs(dir)
    const out = await runApproved(createHostToolDefinitions(svcs), 'host_exec', { command: 'ls' }, ask, 'c1', '拒绝')
    expect(out.denied).toBe(true)
  })

  it('host_notify 返回 ok', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_notify'))({ title: 't', message: 'm' }, {})
    expect(out).toMatchObject({ ok: true })
  })

  it('web_fetch 本地回环被拦截', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'web_fetch'))({ url: 'http://127.0.0.1/' }, {})
    expect(out.blocked).toBe(true)
  })

  it('host_clipboard read', async () => {
    const { svcs } = makeSvcs(dir)
    const out = await execOf(byName(createHostToolDefinitions(svcs), 'host_clipboard'))({ action: 'read' }, {})
    expect('ok' in out).toBe(true)
  })
})