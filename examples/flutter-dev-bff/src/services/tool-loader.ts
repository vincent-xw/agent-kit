import { readdir } from 'node:fs/promises'
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '@agent-kit/core'

const PLUGIN_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs'])

/**
 * 判断一个对象是否是合法的 ToolDefinition。
 * 用 duck typing：有 name 字符串、execute 函数。
 * input schema 不强制要求（部分工具可能无参数）。
 */
export function isValidTool(obj: unknown): obj is ToolDefinition {
  if (!obj || typeof obj !== 'object') return false
  const t = obj as Record<string, unknown>
  return (
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    (typeof t.description === 'string' || t.description === undefined) &&
    typeof t.execute === 'function'
  )
}

export interface ToolLoaderOptions {
  /** 全局工具目录，通常是 ~/.agentkit/tools */
  globalDir?: string
  /** 项目级工具目录，通常是 <cwd>/tools */
  projectDir?: string
}

export class ToolLoader {
  constructor(private options: ToolLoaderOptions = {}) {}

  /**
   * 扫描目录并加载所有插件。
   * 项目级工具排在 Map 之后，合并时覆盖全局同名工具。
   */
  async loadAll(): Promise<ToolDefinition[]> {
    const global = await this.loadFromDir(this.options.globalDir)
    const project = await this.loadFromDir(this.options.projectDir)
    const map = new Map<string, ToolDefinition>()
    for (const t of global) map.set(t.name, t)
    for (const t of project) map.set(t.name, t)
    return [...map.values()]
  }

  private async loadFromDir(dir?: string): Promise<ToolDefinition[]> {
    if (!dir || !existsSync(dir)) return []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const tools: ToolDefinition[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!PLUGIN_EXTENSIONS.has(extname(entry.name))) continue
      if (entry.name.endsWith('.d.ts')) continue
      const file = join(dir, entry.name)
      try {
        // 时间戳 query bust ESM 缓存，文件修改后能重新加载
        const url = pathToFileURL(file).href + '?t=' + Date.now()
        const mod = await import(url)
        const exported = mod.default ?? mod
        if (isValidTool(exported)) {
          tools.push(exported)
        } else {
          console.warn(`[tool-loader] 跳过 ${entry.name}：不是合法的 ToolDefinition`)
        }
      } catch (error) {
        console.warn(`[tool-loader] 加载 ${entry.name} 失败：`, error instanceof Error ? error.message : error)
      }
    }
    return tools
  }

  private watchers: FSWatcher[] = []

  /**
   * 监听工具目录变化，防抖后重新加载并调用 onChange。
   * 返回取消监听函数。
   */
  watch(onChange: (tools: ToolDefinition[]) => void): () => void {
    const dirs = [this.options.globalDir, this.options.projectDir].filter(
      (d): d is string => !!d && existsSync(d),
    )
    let timer: NodeJS.Timeout | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        try {
          const tools = await this.loadAll()
          onChange(tools)
        } catch (error) {
          console.warn('[tool-loader] 热重载失败：', error instanceof Error ? error.message : error)
        }
      }, 300)
    }
    for (const dir of dirs) {
      try {
        const w = fsWatch(dir, { recursive: false }, (event: string, filename: string | null) => {
          if (!filename) return
          if (!PLUGIN_EXTENSIONS.has(extname(filename)) || filename.endsWith('.d.ts')) return
          reload()
        })
        this.watchers.push(w)
      } catch (error) {
        console.warn(`[tool-loader] 监听 ${dir} 失败：`, error instanceof Error ? error.message : error)
      }
    }
    return () => this.stopWatching()
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
  }
}