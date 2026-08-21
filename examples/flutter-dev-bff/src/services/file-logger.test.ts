import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createFileLogger } from './file-logger.js'

describe('createFileLogger', () => {
  it('写入后产生当日 bff-YYYY-MM-DD.log 且包含内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ak-fl-'))
    const h = createFileLogger({ enabled: true, dir, format: 'verbose', keepDays: 7 })
    h.sink.log('第一行 hello')
    h.sink.log('第二行 world')
    await new Promise((r) => setTimeout(r, 500)) // 等 winston flush
    const files = readdirSync(dir).filter((f) => /^bff-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(1)
    const content = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    expect(content).toContain('第一行 hello')
    expect(content).toContain('第二行 world')
    rmSync(dir, { recursive: true, force: true })
  })
})