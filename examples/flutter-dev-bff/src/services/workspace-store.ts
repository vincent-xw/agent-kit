import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WorkspaceStore {
  get(): string
  set(root: string): void
}

/** 全局当前工作区：默认回退，持久化到本地 JSON，重启不丢。 */
export function createWorkspaceStore(options: { filePath: string; fallback: string }): WorkspaceStore {
  let root = options.fallback
  try {
    if (existsSync(options.filePath)) {
      const parsed = JSON.parse(readFileSync(options.filePath, 'utf8')) as { workspace?: unknown }
      if (typeof parsed.workspace === 'string' && parsed.workspace.trim()) root = parsed.workspace
    }
  } catch {
    // 文件损坏时用回退值
  }
  function persist() {
    try {
      mkdirSync(dirname(options.filePath), { recursive: true })
      writeFileSync(options.filePath, JSON.stringify({ workspace: root }, null, 2), 'utf8')
    } catch {
      // 持久化失败不阻断
    }
  }
  return {
    get: () => root,
    set(next) {
      root = next
      persist()
    },
  }
}