# 用户自定义工具注册（Tool 插件）设计

## 目标

让用户在不修改 BFF 源码、不重新编译的情况下，通过放置 JS/TS 文件扩展 Agent 能力。用户工具主要用于调用三方接口和业务 API（查订单、调内部系统、控制 IoT 设备等），与内置的手机操作工具组合使用。

内置工具（adb、CDP、视觉、Flutter 开发流程）保持硬编码，因为它们内聚于 BFF 的有状态服务（adb 客户端、CdpClient、VisionClient）。用户工具不需要访问这些内部服务，只需全局 `fetch` 和 `process.env`。

## 设计决策

1. **Tool 插件而非 Skill**：Skill 解决「怎么用现有工具」，Tool 插件解决「加新能力」。通用 coding agent 用 skill 是因为它们工具通用，而我们的工具领域专用，新能力需要新代码。
2. **方案 A（插件目录）先做，预留方案 B（HTTP 远程工具）**：`defineTool` 接口在两种方案下一致，未来加远程工具时插件格式不变。
3. **JS + TS 双支持**：用 tsx 动态加载，.js 直接 import。
4. **output schema 可选**：和内置工具一致，声明则校验，不声明则透传。
5. **启动加载 + 文件监听热重载**：开发体验好，fs.watch + 防抖。
6. **插件 context 极简**：不给插件暴露 BFF 内部服务实例。插件用全局 fetch 和 process.env 即可，因为它们的用途是调三方 API，不是操作手机。

## 插件格式

```ts
// tools/weather.ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'query_weather',
  description: '查询指定城市的当前天气',
  input: z.object({ city: z.string().describe('城市名，如「杭州」') }),
  output: z.object({ temp: z.number(), condition: z.string() }).optional(),
  execute: async ({ city }) => {
    const apiKey = process.env.WEATHER_API_KEY
    const res = await fetch(`https://api.weather.com/current?q=${encodeURIComponent(city)}&key=${apiKey}`)
    if (!res.ok) throw new Error(`天气 API 返回 ${res.status}`)
    return res.json()
  },
})
```

- `defineTool` 是 identity function，返回标准 `ToolDefinition`，主要用于 TypeScript 类型推断。
- 插件默认导出一个 ToolDefinition。
- 插件可访问 Node 22 全局 `fetch`、`process.env`、`URL`、`Blob` 等标准 API。
- 插件不得访问 BFF 内部状态（设计上不传入 context）。

## 加载机制

### 目录扫描

启动时扫描两个目录：
- 全局：`~/.agentkit/tools/*.{js,ts,mjs,cjs}`
- 项目级：`<cwd>/tools/*.{js,ts,mjs,cjs}`

合并优先级（高到低）：项目级 > 全局级 > 内置。同名工具前者覆盖后者，方便团队定制。

### 动态导入

用 `import(pathToFileURL(file).href + '?t=' + Date.now())` 带时间戳查询参数 bust ESM 缓存。.ts 文件由 tsx 运行时处理（devDependencies 已有）。

### 校验

每个文件导入后：
1. 检查 default export 存在且是对象
2. 检查 `name` 是字符串、`description` 是字符串、`input` 有 parse 方法（zod schema 特征）
3. 检查 `execute` 是函数
4. 校验失败时 `console.warn` 打印文件名和原因，跳过该插件，不阻塞 BFF 启动

### 内置工具与插件合并

`createFlutterToolDefinitions(services)` 返回内置工具数组。ToolLoader 返回插件工具数组。两者 concat 后传给 runtime。插件工具也经过 `instrumentTools` 包装，产生 `tool_start`/`tool_end` SSE 事件。

## 文件监听与热重载

用 `fs.watch(dir, { recursive: false })` 监听两个目录：
- 监听 `add`、`change`、`unlink` 事件
- 300ms 防抖
- 触发时重新扫描、重建插件工具列表、更新 runtime

### runtime 动态工具更新

需要 core 的 runtime 支持运行时替换工具集。实现时确认：
- 若 `runtime.tools.register()` 支持覆盖同名工具，先 unregister 旧的再 register 新的
- 若不支持 unregister，维护一个 `currentToolDefinitions` 引用，runtime 每次调用时从引用读取（而不是启动时快照）
- 工具执行中的请求不受影响（用旧定义跑完），新请求用新定义

重载后通过 EventBus 广播 `tools_reloaded` 事件，SSE 推给前端。前端可显示「工具已更新」提示。

## 包导出

`package.json` 加 exports：

```json
{
  "exports": {
    ".": "./dist/server.js",
    "./define": "./dist/define-tool.js"
  }
}
```

`define-tool.ts` 实现：

```ts
import type { ToolDefinition } from '@agent-kit/core'
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}
```

re-export zod 方便插件引用：`export { z } from 'zod'`（可选，插件可直接 import zod）。

## 错误处理

- 单个插件加载失败：warn 日志，跳过
- 单个插件执行失败：和内置工具一样，error 事件经 SSE 推送，错误返回给 LLM
- 插件目录不存在：静默跳过
- 文件监听失败（权限等）：warn 日志，BFF 正常运行但不支持热重载
- 插件执行超时：暂不单独处理，复用 harness 的工具超时机制

## 测试策略

- `tool-loader.test.ts`：
  - 扫描临时目录加载 .ts 和 .js 插件
  - 非法插件（缺 name、execute 不是函数）被跳过
  - 项目级覆盖全局级同名工具
  - 插件能正常 execute 并返回结果
  - 文件变更后工具列表更新
- 不测试 fs.watch 的 OS 级行为（不稳定），只测试重新扫描逻辑

## 范围之外

- HTTP 远程工具注册（方案 B）——`defineTool` 接口预留，未来加
- MCP 协议支持
- 插件依赖管理（package.json 安装）
- 插件市场、版本号、签名验证
- 给插件暴露 adb/screenshot/vision 等内部服务
- 插件权限沙箱