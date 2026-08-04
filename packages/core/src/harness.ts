import type { z } from 'zod'

import { AgentKitError } from './errors.js'
import type { AuditLogger, HarnessResult, SessionMessage, SessionStore } from './contracts.js'
import type { LlmClient } from './llm-client.js'
import type { PromptRegistry } from './prompt-registry.js'
import type { ToolRegistry } from './tool-registry.js'

/** harness 依赖：LLM 客户端、会话存储、工具注册表与可选的提示词/审计。 */
export interface AgentHarnessDependencies {
  llm: LlmClient
  sessions: SessionStore
  tools: ToolRegistry
  maxSteps: number
  prompts?: PromptRegistry
  audit?: AuditLogger
}

/** 最大步数受限的 模型 -> 工具调用 -> 工具结果 -> 模型 循环。 */
export interface AgentHarness {
  run(request: { sessionId: string; input: string; context: Record<string, unknown> }): Promise<HarnessResult>
  /** 回填远端 Tool Host 执行结果并继续循环。 */
  resume(request: { sessionId: string; callId: string; output: unknown }): Promise<HarnessResult>
}

/** 挂起的远端工具调用记录，用于 resume 时校验 callId 归属。 */
type PendingCall = { sessionId: string; toolName: string }

/** 校验 Zod Schema，失败时统一抛出带稳定错误码的 AgentKitError。 */
function parseWithCode(schema: z.ZodType, value: unknown, code: 'TOOL_INPUT_INVALID' | 'TOOL_OUTPUT_INVALID'): unknown {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AgentKitError(code, '工具数据校验失败')
  return parsed.data
}

/** 执行受最大步数约束的模型与工具循环。 */
export function createAgentHarness(deps: AgentHarnessDependencies): AgentHarness {
  const pendingCalls = new Map<string, PendingCall>()

  function systemPrompt(): string | undefined {
    return deps.prompts?.getDefault()?.prompt
  }

  async function runLoop(
    sessionId: string,
    input: string,
    context: Record<string, unknown>,
    history: SessionMessage[],
  ): Promise<HarnessResult> {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    for (let step = 0; step < deps.maxSteps; step += 1) {
      const startedAt = Date.now()
      const prompt = systemPrompt()
      const result = await deps.llm.complete({ input, context, messages: history, ...(prompt ? { systemPrompt: prompt } : {}) })
      await deps.audit?.log({ requestId, durationMs: Date.now() - startedAt })
      if (result.type === 'final') {
        // 最终输出前持久化完整对话，包含本次用户输入。
        await deps.sessions.save(sessionId, [...history, { role: 'user', content: input }])
        return result
      }
      const tool = deps.tools.get(result.toolName)
      if (!tool) throw new AgentKitError('TOOL_NOT_REGISTERED', `工具未注册：${result.toolName}`)
      const parsedInput = parseWithCode(tool.input, result.input, 'TOOL_INPUT_INVALID')
      if (tool.execution === 'remote') {
        // 远端工具不在此运行时执行：记录挂起调用并保存历史，交由 Tool Host 回填。
        pendingCalls.set(result.callId, { sessionId, toolName: result.toolName })
        await deps.sessions.save(sessionId, [...history, { role: 'user', content: input }])
        return { type: 'pending_tool_call', callId: result.callId, toolName: result.toolName, input: parsedInput }
      }
      if (!tool.execute) throw new AgentKitError('TOOL_EXECUTOR_MISSING', `服务端工具缺少执行器：${result.toolName}`)
      const rawOutput = await tool.execute(parsedInput)
      // 工具输出必须再次校验，避免未受控数据进入后续模型上下文。
      const parsedOutput = parseWithCode(tool.output, rawOutput, 'TOOL_OUTPUT_INVALID')
      history.push({ role: 'tool', content: parsedOutput })
    }
    throw new AgentKitError('HARNESS_STEP_LIMIT', `工具调用超过最大步数：${deps.maxSteps}`)
  }

  return {
    async run(request) {
      const history = [...(await deps.sessions.load(request.sessionId))]
      return runLoop(request.sessionId, request.input, request.context, history)
    },
    async resume(request) {
      const pending = pendingCalls.get(request.callId)
      if (!pending || pending.sessionId !== request.sessionId) {
        throw new AgentKitError('PENDING_CALL_NOT_FOUND', `未找到可回填的工具调用：${request.callId}`)
      }
      const tool = deps.tools.get(pending.toolName)
      if (!tool) throw new AgentKitError('TOOL_NOT_REGISTERED', `工具未注册：${pending.toolName}`)
      const parsedOutput = parseWithCode(tool.output, request.output, 'TOOL_OUTPUT_INVALID')
      pendingCalls.delete(request.callId)
      const history: SessionMessage[] = [...(await deps.sessions.load(request.sessionId)), { role: 'tool' as const, content: parsedOutput }]
      // 回填后继续模型循环，无需再附加新的用户输入。
      return runLoop(request.sessionId, '', {}, history)
    },
  }
}
