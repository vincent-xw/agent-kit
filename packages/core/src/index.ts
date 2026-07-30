import type { z } from 'zod'

/** Agent Kit 当前发布版本。 */
export const AGENT_KIT_VERSION = '0.1.0'

export type ToolCall = { type: 'tool_call'; callId: string; toolName: string; input: unknown }
export type LlmResult = { type: 'final'; output: unknown } | ToolCall
export type HarnessResult = LlmResult | { type: 'pending_tool_call'; callId: string; toolName: string; input: unknown }
export type SessionMessage = { role: 'user' | 'tool'; content: unknown }

export interface ToolDefinition<I, O> {
  name: string
  execution: 'server' | 'remote'
  input: z.ZodType<I>
  output: z.ZodType<O>
  execute?: (input: I) => Promise<O>
}

/** 工具注册表只接受显式注册的工具，阻止模型调用任意名称。 */
export function createToolRegistry() {
  const definitions = new Map<string, ToolDefinition<unknown, unknown>>()
  return {
    register(definition: ToolDefinition<unknown, unknown>) { definitions.set(definition.name, definition) },
    get(name: string) { return definitions.get(name) },
  }
}

/** 内存存储仅用于测试和无持久化场景，生产环境应由适配器替换。 */
export function createMemorySessionStore() {
  const sessions = new Map<string, SessionMessage[]>()
  return {
    load(sessionId: string) { return sessions.get(sessionId) ?? [] },
    save(sessionId: string, messages: SessionMessage[]) { sessions.set(sessionId, messages) },
  }
}

type Dependencies = {
  llm: { complete(request: { input: string; context: Record<string, unknown>; messages: SessionMessage[] }): Promise<LlmResult> }
  sessions: ReturnType<typeof createMemorySessionStore>
  tools: ReturnType<typeof createToolRegistry>
  maxSteps: number
}

/** 执行受最大步数约束的模型与工具循环。 */
export function createAgentHarness(deps: Dependencies) {
  return {
    async run(request: { sessionId: string; input: string; context: Record<string, unknown> }): Promise<HarnessResult> {
      const messages = [...deps.sessions.load(request.sessionId), { role: 'user' as const, content: request.input }]
      for (let step = 0; step < deps.maxSteps; step += 1) {
        const result = await deps.llm.complete({ input: request.input, context: request.context, messages })
        if (result.type === 'final') {
          deps.sessions.save(request.sessionId, messages)
          return result
        }
        const tool = deps.tools.get(result.toolName)
        if (!tool) throw new Error(`TOOL_NOT_REGISTERED:${result.toolName}`)
        const input = tool.input.parse(result.input)
        if (tool.execution === 'remote') return { type: 'pending_tool_call', callId: result.callId, toolName: result.toolName, input }
        if (!tool.execute) throw new Error(`TOOL_EXECUTOR_MISSING:${result.toolName}`)
        // 工具输出必须再次校验，避免未受控数据进入后续模型上下文。
        messages.push({ role: 'tool', content: tool.output.parse(await tool.execute(input)) })
      }
      throw new Error('HARNESS_STEP_LIMIT')
    },
  }
}
