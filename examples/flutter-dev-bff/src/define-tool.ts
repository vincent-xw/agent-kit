import type { ToolDefinition } from '@agent-kit/core'

/**
 * 定义一个用户自定义工具。identity 函数，仅用于 TypeScript 类型推断。
 * 插件文件默认导出此函数的返回值。
 *
 * @example
 * ```ts
 * export default defineTool({
 *   name: 'query_weather',
 *   description: '查询天气',
 *   input: z.object({ city: z.string() }),
 *   execute: async ({ city }) => fetch(`https://api.example.com/?q=${city}`).then(r => r.json()),
 * })
 * ```
 */
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}