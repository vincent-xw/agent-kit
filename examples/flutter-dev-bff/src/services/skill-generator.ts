import type { LlmClient } from '@agent-kit/core'
import type { ToolDefinition } from '@agent-kit/core'
import { slugify, type SkillMeta } from './skill-store.js'

export interface GeneratedSkill {
  slug: string
  meta: SkillMeta
  prompt: string
}

const GENERATE_SYSTEM_PROMPT = `你是一个 Agent Skill 设计专家。根据用户想用大白话完成的任务，结合 Agent 拥有的工具列表，生成一份高质量的系统提示词（Skill Prompt）。

要求：
1. 提示词要清晰描述任务目标、执行步骤、注意事项。
2. 只能使用提供的工具，不要发明不存在的工具。
3. 每个动作后要验证效果（重新快照或检查返回值），不要假设成功。
4. 最后必须给用户明确的中文总结：成功/失败、做了什么。
5. 输出严格的 JSON，包含三个字段：
   - name: skill 的简短英文名（用于目录名，kebab-case）
   - description: 一句话中文描述这个 skill 做什么
   - tools: 这个 skill 会用到的工具名数组
   - prompt: 完整的中文系统提示词

只输出 JSON，不要任何额外解释或 markdown 代码块。`

const OPTIMIZE_SYSTEM_PROMPT = `你是一个 Agent Skill 优化专家。根据 Skill 的当前提示词和它的历史执行记录，分析失败原因，改进提示词。

要求：
1. 分析历史记录中的失败模式和成功模式。
2. 改进提示词，使其更稳健、更准确。
3. 保留原有提示词中的有效部分。
4. 只能使用提供的工具，不要发明不存在的工具。
5. 输出严格的 JSON，包含两个字段：
   - analysis: 对历史执行的分析（中文，不超过200字）
   - prompt: 优化后的完整系统提示词（中文）
   - version: 新的版本号（在原版本号基础上递增小版本，如 1.0.0 → 1.1.0）

只输出 JSON，不要任何额外解释或 markdown 代码块。`

/**
 * 用 LLM 把用户的大白话描述生成成一个 Skill。
 * 纯生成，不保存，交给用户核验后再存。
 */
export async function generateSkill(
  llm: LlmClient,
  tools: ToolDefinition[],
  userIntent: string,
): Promise<GeneratedSkill> {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n')

  const result = await llm.complete({
    input: `我想要：${userIntent}\n\n可用工具：\n${toolList}`,
    context: { platform: 'skill-generator' },
    messages: [],
    systemPrompt: GENERATE_SYSTEM_PROMPT,
  })

  if (result.type !== 'final' || typeof result.output !== 'string') {
    throw new Error('LLM 未返回文本结果（可能返回了工具调用）')
  }
  const text = result.output
  // 模型可能包 ```json，容错剥掉
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: { name: string; description: string; tools?: string[]; prompt: string }
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${(e as Error).message}\n原始返回: ${text.slice(0, 300)}`)
  }

  if (!parsed.name || !parsed.prompt) {
    throw new Error('LLM 返回缺少 name 或 prompt 字段')
  }

  const now = new Date().toISOString()
  const meta: SkillMeta = {
    name: parsed.name,
    description: parsed.description || '',
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
  }
  if (parsed.tools) meta.tools = parsed.tools
  return {
    slug: slugify(parsed.name),
    meta,
    prompt: parsed.prompt,
  }
}

export interface OptimizeResult {
  analysis: string
  prompt: string
  version: string
}

/**
 * 根据历史执行记录优化 Skill 的提示词。
 * 读取 runs/ 下的所有记录，把成功/失败模式发给 LLM，生成改进版 prompt。
 */
export async function optimizeSkill(
  llm: LlmClient,
  tools: ToolDefinition[],
  currentPrompt: string,
  runs: Array<{ status: string; summary?: string; error?: string; steps?: number; startedAt: string }>,
  currentVersion: string,
): Promise<OptimizeResult> {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n')
  const runLog = runs
    .map((r) => `[${r.startedAt}] ${r.status} ${r.summary ?? ''} ${r.error ?? ''} (${r.steps ?? '?'}步)`)
    .join('\n')

  const result = await llm.complete({
    input: `当前提示词：\n---\n${currentPrompt}\n---\n\n历史执行记录：\n${runLog}\n\n当前版本：${currentVersion}\n\n可用工具：\n${toolList}`,
    context: { platform: 'skill-optimizer' },
    messages: [],
    systemPrompt: OPTIMIZE_SYSTEM_PROMPT,
  })

  if (result.type !== 'final' || typeof result.output !== 'string') {
    throw new Error('LLM 未返回文本结果')
  }
  const text = result.output
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: { analysis: string; prompt: string; version: string }
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${(e as Error).message}\n原始返回: ${text.slice(0, 300)}`)
  }
  if (!parsed.prompt) throw new Error('LLM 返回缺少 prompt 字段')
  return { analysis: parsed.analysis || '', prompt: parsed.prompt, version: parsed.version || currentVersion }
}
