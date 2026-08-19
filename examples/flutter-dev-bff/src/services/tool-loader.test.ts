import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolLoader } from './tool-loader.js'

describe('ToolLoader', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tools-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('加载 .js 插件文件', async () => {
    writeFileSync(join(tmp, 'hello.js'), `
      export default {
        name: 'say_hello',
        description: 'say hi',
        input: { parse: (v) => v },
        execute: async () => ({ ok: true, message: 'hi' }),
      }
    `)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('say_hello')
  })

  it('加载 .ts 插件文件', async () => {
    writeFileSync(join(tmp, 'weather.ts'), `
      import { z } from 'zod'
      export default {
        name: 'query_weather',
        description: 'query weather',
        input: z.object({ city: z.string() }),
        execute: async ({ city }: { city: string }) => ({ city, temp: 25 }),
      }
    `)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools[0]!.name).toBe('query_weather')
    const result = await tools[0]!.execute({ city: '杭州' })
    expect(result).toEqual({ city: '杭州', temp: 25 })
  })

  it('跳过没有默认导出的文件', async () => {
    writeFileSync(join(tmp, 'bad.js'), `export const x = 1`)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })

  it('跳过缺少 name 或 execute 的非法插件', async () => {
    writeFileSync(join(tmp, 'bad.js'), `export default { description: 'no name' }`)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })

  it('项目级工具覆盖全局级同名工具', async () => {
    const global = mkdtempSync(join(tmpdir(), 'gtools-'))
    mkdirSync(global, { recursive: true })
    writeFileSync(join(global, 'same.js'), `
      export default { name: 'same', description: 'global', input:{parse:v=>v}, execute: async () => 'global' }
    `)
    writeFileSync(join(tmp, 'same.js'), `
      export default { name: 'same', description: 'project', input:{parse:v=>v}, execute: async () => 'project' }
    `)
    const loader = new ToolLoader({ globalDir: global, projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(1)
    expect(await tools[0]!.execute({})).toBe('project')
    rmSync(global, { recursive: true, force: true })
  })

  it('目录不存在时静默返回空数组', async () => {
    const loader = new ToolLoader({ projectDir: join(tmp, 'nonexistent') })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })
})