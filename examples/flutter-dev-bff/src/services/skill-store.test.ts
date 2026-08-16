import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillStore, slugify } from './skill-store.js'

let dirs: string[] = []
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'skills-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('SkillStore', () => {
  it('保存后能列出和读取', () => {
    const store = new SkillStore(tmpDir())
    const now = new Date().toISOString()
    store.save('login-demo', {
      name: 'login-demo', description: '登录演示', version: '1.0.0',
      createdAt: now, updatedAt: now, tools: ['mobile_snapshot'],
    }, '你是一个登录助手')
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.slug).toBe('login-demo')
    expect(list[0]!.meta.name).toBe('login-demo')
    const skill = store.get('login-demo')!
    expect(skill.prompt).toBe('你是一个登录助手')
    expect(skill.runs).toEqual([])
  })

  it('记录和读取执行历史', () => {
    const store = new SkillStore(tmpDir())
    const now = new Date().toISOString()
    store.save('s1', { name: 's1', description: '', version: '1.0.0', createdAt: now, updatedAt: now }, 'prompt')
    store.addRun('s1', { id: 'r1', startedAt: now, status: 'completed', summary: '成功', steps: 3 })
    const skill = store.get('s1')!
    expect(skill.runs).toHaveLength(1)
    expect(skill.runs[0]!.status).toBe('completed')
  })

  it('删除后读取返回 null', () => {
    const store = new SkillStore(tmpDir())
    const now = new Date().toISOString()
    store.save('s2', { name: 's2', description: '', version: '1.0.0', createdAt: now, updatedAt: now }, 'p')
    store.delete('s2')
    expect(store.get('s2')).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  it('损坏的 skill 目录不影响列表', () => {
    const dir = tmpDir()
    const store = new SkillStore(dir)
    const now = new Date().toISOString()
    store.save('good', { name: 'good', description: '', version: '1.0.0', createdAt: now, updatedAt: now }, 'p')
    // 手动建一个缺文件的坏目录
    const { mkdirSync } = require('node:fs')
    mkdirSync(join(dir, 'bad'))
    expect(store.list().map((s) => s.slug)).toEqual(['good'])
  })
})

describe('slugify', () => {
  it('英文转 kebab-case', () => {
    expect(slugify('Login and Check H5')).toBe('login-and-check-h5')
  })
  it('纯中文用兜底', () => {
    const slug = slugify('登录并检查')
    expect(slug).toMatch(/^skill-/)
  })
})
