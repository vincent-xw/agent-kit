import type { z } from 'zod'

import { AgentKitError } from './errors.js'
import { toToolSchemas } from './json-schema.js'
import type {
  AuditLogger,
  HarnessResult,
  LlmResult,
  PendingCall,
  PendingCallStore,
  SessionMessage,
  SessionStore,
  ToolCall,
  ToolDefinition,
} from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmClient } from './llm-client.js'
import type { PromptRegistry } from './prompt-registry.js'
import type { ToolRegistry } from './tool-registry.js'

/** harness 依赖：LLM 客户端、会话存储、工具注册表与可选的提示词/审计/上下文/挂起存储。 */
export interface AgentHarnessDependencies {
  llm: LlmClient
  sessions: SessionStore
  tools: ToolRegistry
  maxSteps: number
  prompts?: PromptRegistry
  audit?: AuditLogger
  /** 上下文管理器：提供历史裁剪。未注入时发送完整历史。 */
  context?: ContextManager
  /** 挂起调用存储。未注入时使用进程内实现（进程重启即丢）。 */
  pendingCalls?: PendingCallStore
  /** 服务端工具的默认执行超时毫秒数，默认 30 秒。 */
  toolTimeoutMs?: number
}

/** 最大步数受限的 模型 -> 工具调用 -> 工具结果 -> 模型 循环。 */
export interface AgentHarness {
  run(request: {
    sessionId: string
    input: string
    context: Record<string, unknown>
    /** 指定使用哪个已注册提示词；省略时用默认（首个注册）提示词。 */
    promptName?: string
    /** 跳过工具声明：不发 tools 字段，模型只能输出文本。用于计划阶段。 */
    skipTools?: boolean
  }): Promise<HarnessResult>
  /** 回填远端 Tool Host 执行结果并继续循环。 */
  resume(request: { sessionId: string; callId: string; output: unknown }): Promise<HarnessResult>
}

/** 校验 Zod Schema，失败时统一抛出带稳定错误码的 AgentKitError。 */
function parseWithCode(schema: z.ZodType, value: unknown, code: 'TOOL_INPUT_INVALID' | 'TOOL_OUTPUT_INVALID'): unknown {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AgentKitError(code, '工具数据校验失败')
  return parsed.data
}

/** 进程内挂起调用存储；宿主可注入持久化实现替换。 */
function createMemoryPendingCallStore(): PendingCallStore {
  const calls = new Map<string, PendingCall>()
  return {
    get: (callId) => calls.get(callId),
    set: (callId, call) => void calls.set(callId, call),
    delete: (callId) => void calls.delete(callId),
  }
}

/**
 * 在超时约束下执行服务端工具。
 * 没有超时的话，一个挂住的工具会永久挂住整个 harness 循环——调用方连失败都收不到。
 */
async function executeWithTimeout(tool: ToolDefinition, input: unknown, timeoutMs: number): Promise<unknown> {
  if (!tool.execute) throw new AgentKitError('TOOL_EXECUTOR_MISSING', `服务端工具缺少执行器：${tool.name}`)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await tool.execute(input, { signal: controller.signal })
  } catch (error) {
    if (timedOut) {
      throw new AgentKitError('TOOL_EXECUTION_TIMEOUT', `工具执行超时：${tool.name}`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 执行受最大步数约束的模型与工具循环。 */
export function createAgentHarness(deps: AgentHarnessDependencies): AgentHarness {
  const pendingCalls = deps.pendingCalls ?? createMemoryPendingCallStore()
  const toolTimeoutMs = deps.toolTimeoutMs ?? 30_000

  /**
   * 按名解析提示词；未指定名称时回退到默认（首个注册）提示词。
   * 之前这里死取 getDefault()，导致第二个注册的提示词及其输出协议永远无法生效。
   */
  function resolvePrompt(promptName?: string) {
    if (!deps.prompts) return undefined
    if (!promptName) return deps.prompts.getDefault()
    const found = deps.prompts.getByName(promptName)
    if (!found) throw new AgentKitError('PROMPT_NOT_FOUND', `提示词未注册：${promptName}`)
    return found
  }

  /**
   * 应用上下文裁剪，并把裁剪摘要作为 system 消息前置。
   * 不注入摘要的话模型不知道自己丢了上下文——它会以为看到的就是完整历史。
   */
  function trimHistory(sessionId: string, history: SessionMessage[]): SessionMessage[] {
    if (!deps.context) return history
    deps.context.save(sessionId, history)
    const trimmed = deps.context.load(sessionId)
    const summary = deps.context.getSummary(sessionId)
    if (!summary) return trimmed
    return [{ role: 'system', content: summary }, ...trimmed]
  }

  /** 校验模型最终输出是否符合 prompt 声明的输出协议。 */
  function applyOutputProtocol(output: unknown, promptName?: string): unknown {
    const protocol = resolvePrompt(promptName)?.protocol
    if (!protocol) return output
    // 声明了 JSON 协议时模型返回的是 JSON 文本，先解析再校验。
    let candidate = output
    if (typeof output === 'string') {
      try {
        candidate = JSON.parse(output)
      } catch {
        throw new AgentKitError('LLM_OUTPUT_PROTOCOL_INVALID', '模型输出不是有效 JSON，不符合已声明的输出协议')
      }
    }
    const parsed = protocol.safeParse(candidate)
    if (!parsed.success) {
      throw new AgentKitError('LLM_OUTPUT_PROTOCOL_INVALID', '模型输出不符合已声明的输出协议')
    }
    return parsed.data
  }

  async function runLoop(
    sessionId: string,
    input: string,
    context: Record<string, unknown>,
    history: SessionMessage[],
    promptName?: string,
    skipTools?: boolean,
  ): Promise<HarnessResult> {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    // 本次用户输入在首轮发出后即并入历史，避免后续轮次重复追加。
    let pendingInput = input
    for (let step = 0; step < deps.maxSteps; step += 1) {
      const startedAt = Date.now()
      const prompt = resolvePrompt(promptName)
      const toolSchemas = skipTools ? [] : toToolSchemas(deps.tools.list())
      // LLM 调用失败时也要留一笔审计，否则服务端只看到请求进来、没有任何后续痕迹。
      let result: LlmResult
      try {
        result = await deps.llm.complete({
          ...(pendingInput ? { input: pendingInput } : {}),
          context,
          messages: trimHistory(sessionId, history),
          ...(prompt?.prompt ? { systemPrompt: prompt.prompt } : {}),
          ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
          ...(prompt?.protocol ? { responseFormatJson: true } : {}),
        })
      } catch (error) {
        await deps.audit?.log({
          requestId,
          durationMs: Date.now() - startedAt,
          errorCode: error instanceof AgentKitError ? error.code : 'LLM_CALL_FAILED',
        })
        throw error
      }
      await deps.audit?.log({ requestId, durationMs: Date.now() - startedAt })
      if (pendingInput) {
        history.push({ role: 'user', content: pendingInput })
        pendingInput = ''
      }

      if (result.type === 'final') {
        const output = applyOutputProtocol(result.output, promptName)
        history.push({ role: 'assistant', content: result.output })
        await deps.sessions.save(sessionId, history)
        return { type: 'final', output, ...(result.reasoning ? { reasoning: result.reasoning } : {}) }
      }

      // assistant 轮次必须入库：否则模型看不到自己发起过哪些调用，工具结果就成了无主消息。
      history.push({ role: 'assistant', content: null, toolCalls: result.calls })

      const remoteCalls: Array<{ callId: string; toolName: string; input: unknown }> = []
      for (const call of result.calls) {
        const tool = deps.tools.get(call.toolName)
        if (!tool) throw new AgentKitError('TOOL_NOT_REGISTERED', `工具未注册：${call.toolName}`)
        const parsedInput = parseWithCode(tool.input, call.input, 'TOOL_INPUT_INVALID')
        if (tool.execution === 'remote') {
          // promptName 随挂起状态保存：resume 要用同一个提示词继续。
          await pendingCalls.set(call.callId, {
            sessionId,
            toolName: call.toolName,
            ...(promptName ? { promptName } : {}),
          })
          remoteCalls.push({ callId: call.callId, toolName: call.toolName, input: parsedInput })
          continue
        }
        // 单个工具的执行失败不中断整轮：把失败结果一并回传，让模型自己决定如何补救。
        // 但 Schema 校验失败是契约违约（工具定义与模型输出不匹配），必须直接抛出而不是喂回模型。
        let rawOutput: unknown
        try {
          rawOutput = await executeWithTimeout(tool, parsedInput, tool.timeoutMs ?? toolTimeoutMs)
        } catch (error) {
          const code = error instanceof AgentKitError ? error.code : 'TOOL_EXECUTION_ABORTED'
          await deps.audit?.log({ requestId, durationMs: 0, toolName: call.toolName, errorCode: code })
          history.push({
            role: 'tool',
            content: { ok: false, code, message: error instanceof Error ? error.message : '工具执行失败' },
            callId: call.callId,
            toolName: call.toolName,
          })
          continue
        }
        const parsedOutput = parseWithCode(tool.output, rawOutput, 'TOOL_OUTPUT_INVALID')
        history.push({ role: 'tool', content: parsedOutput, callId: call.callId, toolName: call.toolName })
      }

      // 本轮存在远端调用时整轮挂起：全部 callId 回填完毕后才继续。
      if (remoteCalls.length > 0) {
        await deps.sessions.save(sessionId, history)
        return { type: 'pending_tool_calls', calls: remoteCalls }
      }
    }
    throw new AgentKitError('HARNESS_STEP_LIMIT', `工具调用超过最大步数：${deps.maxSteps}`)
  }

  /** 判断本轮 assistant 发起的调用是否已全部回填。 */
  function hasUnfilledCalls(history: SessionMessage[]): boolean {
    const expected = new Set<string>()
    for (const message of history) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) expected.add(call.callId)
      }
      if (message.role === 'tool') expected.delete(message.callId)
    }
    return expected.size > 0
  }

  /**
   * 清除历史中「只发起了工具调用、没有对应结果」的残破轮次。
   *
   * 这类残破历史是任务中止的产物：一轮含远端调用时，harness 先持久化了带 toolCalls 的
   * assistant 消息，结果没回来任务就停了（用户停止、断连、sidepanel 关闭）。
   * 之后同一会话再发新指令，`run()` 会把这条残破历史原样发给模型，
   * 而 OpenAI 兼容端点要求每个 tool_call_id 都有对应结果，于是直接 400。
   *
   * 修复策略：新指令意味着上一轮已被放弃，把那些没有结果的 assistant 消息连同
   * 它们后面悬空的 tool 消息一起裁掉，只保留完整往返。
   */
  function sanitizeIncompleteRounds(history: SessionMessage[]): SessionMessage[] {
    const filledCallIds = new Set(history.filter((m) => m.role === 'tool').map((m) => (m as { callId: string }).callId))
    const keptAssistantCallIds = new Set<string>()
    const result: SessionMessage[] = []
    for (const message of history) {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        // 只要有一个调用没回填，整条 assistant 连同它的未回填调用都丢弃。
        if (!message.toolCalls.every((call) => filledCallIds.has(call.callId))) continue
        for (const call of message.toolCalls) keptAssistantCallIds.add(call.callId)
      }
      if (message.role === 'tool') {
        // 它的 assistant 已被丢弃，这条 tool 结果也无主，一并丢弃。
        if (!keptAssistantCallIds.has(message.callId)) continue
      }
      result.push(message)
    }
    return result
  }

  return {
    async run(request) {
      let history = [...(await deps.sessions.load(request.sessionId))]
      const sanitized = sanitizeIncompleteRounds(history)
      if (sanitized.length !== history.length) {
        // 残破历史被裁掉后写回，避免下次再踩同一个 400。
        await deps.sessions.save(request.sessionId, sanitized)
        history = sanitized
      }
      return runLoop(request.sessionId, request.input, request.context, history, request.promptName, request.skipTools)
    },
    async resume(request) {
      const pending = await pendingCalls.get(request.callId)
      if (!pending || pending.sessionId !== request.sessionId) {
        throw new AgentKitError('PENDING_CALL_NOT_FOUND', `未找到可回填的工具调用：${request.callId}`)
      }
      const tool = deps.tools.get(pending.toolName)
      if (!tool) throw new AgentKitError('TOOL_NOT_REGISTERED', `工具未注册：${pending.toolName}`)
      const parsedOutput = parseWithCode(tool.output, request.output, 'TOOL_OUTPUT_INVALID')
      await pendingCalls.delete(request.callId)
      const history: SessionMessage[] = [
        ...(await deps.sessions.load(request.sessionId)),
        { role: 'tool', content: parsedOutput, callId: request.callId, toolName: pending.toolName },
      ]
      // 同轮还有未回填的调用时不推进模型，只落库并回报剩余待办。
      if (hasUnfilledCalls(history)) {
        await deps.sessions.save(request.sessionId, history)
        return { type: 'pending_tool_calls', calls: await remainingCalls(history) }
      }
      // 回填后继续模型循环，沿用发起调用时的提示词，无需再附加新的用户输入。
      return runLoop(request.sessionId, '', {}, history, pending.promptName)
    },
  }

  /** 收集历史中尚未回填的远端调用，供 resume 回报。 */
  async function remainingCalls(history: SessionMessage[]): Promise<Array<{ callId: string; toolName: string; input: unknown }>> {
    const filled = new Set(history.filter((message) => message.role === 'tool').map((message) => (message as { callId: string }).callId))
    const remaining: Array<{ callId: string; toolName: string; input: unknown }> = []
    for (const message of history) {
      if (message.role !== 'assistant' || !message.toolCalls) continue
      for (const call of message.toolCalls) {
        if (!filled.has(call.callId)) remaining.push({ callId: call.callId, toolName: call.toolName, input: call.input })
      }
    }
    return remaining
  }
}
