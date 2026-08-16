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
