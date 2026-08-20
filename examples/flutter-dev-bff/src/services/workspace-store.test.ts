import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createWorkspaceStore } from './workspace-store.js'

let dir = ''

describe('WorkspaceStore', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-ws-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认回退值', () => {
    const s = createWorkspaceStore({ filePath: join(dir, 's.json'), fallback: '/def' })
    expect(s.get()).toBe('/def')
  })

  it('set 后持久化、重建后读回', () => {
    const file = join(dir, 's.json')
    const s = createWorkspaceStore({ filePath: file, fallback: '/def' })
    s.set('/Users/x/w')
    const s2 = createWorkspaceStore({ filePath: file, fallback: '/def' })
    expect(s2.get()).toBe('/Users/x/w')
  })

  it('损坏文件回退默认值', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{ not json', 'utf8')
    const s = createWorkspaceStore({ filePath: file, fallback: '/def' })
    expect(s.get()).toBe('/def')
  })
})