import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Skill 元数据，存于每个 skill 目录的 skill.yaml。
 * prompt 是该 skill 的系统提示词；runs 是历史执行记录。
 */
export interface SkillMeta {
  name: string
  description: string
  icon?: string
  version: string
  /** 这个 skill 用到的工具名，生成时由 LLM 填写，核验时用来校验工具存在 */
  tools?: string[]
  createdAt: string
  updatedAt: string
}

export interface SkillRun {
  id: string
  startedAt: string
  finishedAt?: string
  /** 用户输入（如果 skill 接受参数） */
  input?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** 最终结果摘要 */
  summary?: string
  error?: string
  /** 执行了多少步 */
  steps?: number
}

export interface Skill {
  meta: SkillMeta
  prompt: string
  runs: SkillRun[]
}

/**
 * 管理 skills 目录下的 skill。
 * 目录结构：
 *   skills/<slug>/skill.yaml
 *   skills/<slug>/prompt.md
 *   skills/<slug>/runs/<timestamp>.json
 */
export class SkillStore {
  constructor(private readonly skillsDir: string) {
    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true })
  }

  list(): Array<{ slug: string; meta: SkillMeta }> {
    const entries = readdirSync(this.skillsDir, { withFileTypes: true })
    const result: Array<{ slug: string; meta: SkillMeta }> = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const metaPath = join(this.skillsDir, e.name, 'skill.yaml')
      if (!existsSync(metaPath)) continue
      try {
        result.push({ slug: e.name, meta: parseYamlFrontmatter(readFileSync(metaPath, 'utf-8')) })
      } catch {
        // 损坏的 skill 跳过，不影响列表
      }
    }
    return result.sort((a, b) => (a.meta.updatedAt < b.meta.updatedAt ? 1 : -1))
  }

  get(slug: string): Skill | null {
    const dir = join(this.skillsDir, slug)
    const metaPath = join(dir, 'skill.yaml')
    const promptPath = join(dir, 'prompt.md')
    if (!existsSync(metaPath) || !existsSync(promptPath)) return null
    const meta = parseYamlFrontmatter(readFileSync(metaPath, 'utf-8'))
    const prompt = readFileSync(promptPath, 'utf-8')
    const runs = this.loadRuns(slug)
    return { meta, prompt, runs }
  }

  save(slug: string, meta: SkillMeta, prompt: string): void {
    const dir = join(this.skillsDir, slug)
    mkdirSync(join(dir, 'runs'), { recursive: true })
    writeFileSync(join(dir, 'skill.yaml'), stringifyYamlFrontmatter(meta), 'utf-8')
    writeFileSync(join(dir, 'prompt.md'), prompt, 'utf-8')
  }

  delete(slug: string): void {
    const dir = join(this.skillsDir, slug)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  addRun(slug: string, run: SkillRun): void {
    const dir = join(this.skillsDir, slug, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8')
  }

  updateRun(slug: string, run: SkillRun): void {
    this.addRun(slug, run)
  }

  private loadRuns(slug: string): SkillRun[] {
    const runsDir = join(this.skillsDir, slug, 'runs')
    if (!existsSync(runsDir)) return []
    return readdirSync(runsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(runsDir, f), 'utf-8')) as SkillRun
        } catch {
          return null
        }
      })
      .filter((r): r is SkillRun => r !== null)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }
}

/** 极简 YAML frontmatter 解析（只处理扁平 key: value）。skill.yaml 用 --- 包裹。 */
function parseYamlFrontmatter(content: string): SkillMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('invalid skill.yaml: missing frontmatter')
  const meta: Record<string, unknown> = {}
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (typeof value === 'string' && /^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
    }
    meta[key] = value
  }
  return meta as unknown as SkillMeta
}

function stringifyYamlFrontmatter(meta: SkillMeta): string {
  const lines = [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `version: ${meta.version}`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
  ]
  if (meta.icon) lines.push(`icon: ${meta.icon}`)
  if (meta.tools?.length) lines.push(`tools: [${meta.tools.join(', ')}]`)
  lines.push('---', '')
  return lines.join('\n')
}

/** 把中文/任意名称转成安全的目录名（slug）。 */
export function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii && ascii.length >= 2) return ascii.slice(0, 48)
  // 纯中文等非 ASCII：用时间戳兜底
  return 'skill-' + Date.now().toString(36)
}
