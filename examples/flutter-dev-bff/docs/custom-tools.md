# 自定义工具开发指南

## 概述

Flutter Dev BFF 内置了 25 个工具（设备操作、无障碍交互、WebView、视觉分析、Flutter 开发流程）。你可以通过在 `tools/` 目录放置 JS/TS 文件来扩展 Agent 的能力，**无需修改 BFF 源码或重新编译**。

插件的定位是「给 Agent 装上业务能力」——查订单、调内部 API、控制 IoT 设备、查询数据库等。操作手机的工具都已内置，插件不直接访问 adb 或截图服务。

## 快速开始

### 1. 创建工具文件

在项目根目录创建 `tools/weather.ts`：

```ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'query_weather',
  description: '查询指定城市的当前天气',
  input: z.object({
    city: z.string().describe('城市名，如「杭州」'),
  }),
  output: z.object({
    temp: z.number(),
    condition: z.string(),
  }).optional(),
  execute: async ({ city }) => {
    const apiKey = process.env.WEATHER_API_KEY
    const res = await fetch(
      `https://api.weather.com/current?q=${encodeURIComponent(city)}&key=${apiKey}`
    )
    if (!res.ok) throw new Error(`天气 API 返回 ${res.status}`)
    return res.json()
  },
})
```

### 2. 启动 BFF

```bash
pnpm dev:flutter
```

日志会显示：

```
[flutter-bff] 加载了 1 个用户工具插件：query_weather
```

### 3. 使用工具

在 Web UI 里对 Agent 说「查一下杭州的天气」，Agent 会自动调用 `query_weather`。

修改文件保存后会自动热重载，无需重启。

## 插件目录

BFF 启动时扫描两个目录：

| 目录 | 用途 | 提交到 git |
|------|------|-----------|
| `./tools/*.{js,ts,mjs,cjs}` | 项目级工具，跟项目走 | ✅ 推荐 |
| `~/.agentkit/tools/*.{js,ts,mjs,cjs}` | 全局工具，你自己的 | ❌ 不提交 |

同名工具的优先级：**项目级 > 全局级 > 内置工具**。这样团队可以用项目级工具覆盖默认行为。

## API 参考

### defineTool(definition)

identity 函数，仅用于 TypeScript 类型推断。返回传入的 definition。

```ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'my_tool',
  description: '工具用途说明，Agent 据此决定何时调用',
  input: z.object({ ... }),
  output: z.object({ ... }).optional(),
  execute: async (input) => { ... },
})
```

### 工具定义字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✅ | 工具名，snake_case，全局唯一 |
| `description` | `string` | ✅ | 告诉 Agent 这个工具做什么、什么时候用 |
| `input` | `z.ZodType` | ✅ | 用 zod 声明输入参数 schema |
| `output` | `z.ZodType` | ❌ | 用 zod 声明返回值 schema，声明则校验 |
| `execute` | `(input, context?) => Promise<unknown>` | ✅ | 工具执行函数 |

### 运行环境

插件运行在 Node.js 22+，可以使用：

- **全局 `fetch`** — 调用任何 HTTP API
- **`process.env`** — 读取环境变量和密钥
- **Node 内置模块** — `crypto`、`fs`、`path`、`stream` 等
- **`zod`** — schema 校验（BFF 已安装，直接 import）

插件**不能**访问：

- `adb` / `CdpClient` / `VisionClient` 等 BFF 内部服务
- BFF 的 Hono app 或 runtime
- 文件系统的任意路径（虽然技术上可以，但不推荐）

这些限制是有意的——操作手机的能力全部由内置工具提供，插件专注于业务逻辑。

## 编写高质量工具

### description 要写清楚「何时用」

Agent 根据 description 判断要不要调用工具。差的 description：

```ts
description: '查天气'
```

好的 description：

```ts
description: '查询指定中国城市的实时天气。当用户询问天气、气温、出门是否带伞时使用。'
```

### input 用 describe 说明参数

```ts
input: z.object({
  city: z.string().describe('城市名，不带「市」字，如「杭州」'),
  days: z.number().min(1).max(7).describe('预报天数，1-7'),
})
```

这些描述会发给 LLM，帮助它正确填参数。

### 错误要抛出，不要返回

```ts
// ✅ 好：抛错，BFF 会转成工具失败结果发给 LLM
if (!res.ok) throw new Error(`API 返回 ${res.status}`)

// ❌ 差：返回错误对象，LLM 不知道失败了
return { error: 'API failed' }
```

### 敏感信息走环境变量

```ts
const token = process.env.MY_SERVICE_TOKEN
if (!token) throw new Error('缺少 MY_SERVICE_TOKEN 环境变量')
```

在 `.env` 文件里配置（已被 gitignore）。

### 返回 JSON 可序列化数据

只能返回 JSON.stringify 能处理的数据：对象、数组、字符串、数字、布尔、null。不要返回 class 实例、函数、Symbol。

## 示例

### 调用内部 REST API

```ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'query_order',
  description: '根据订单号查询内部系统的订单状态',
  input: z.object({
    orderId: z.string().describe('订单号'),
  }),
  execute: async ({ orderId }) => {
    const res = await fetch(`https://internal.example.com/api/orders/${orderId}`, {
      headers: { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
    })
    if (!res.ok) throw new Error(`查询失败: ${res.status}`)
    return res.json()
  },
})
```

### 发送通知

```ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'send_notification',
  description: '向指定 webhook 发送通知消息',
  input: z.object({
    message: z.string().describe('通知内容'),
    level: z.enum(['info', 'warn', 'error']).default('info'),
  }),
  execute: async ({ message, level }) => {
    const webhook = process.env.NOTIFICATION_WEBHOOK_URL
    if (!webhook) throw new Error('未配置 NOTIFICATION_WEBHOOK_URL')
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[${level}] ${message}` }),
    })
    return { sent: true }
  },
})
```

### 无参数工具

```ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'get_server_time',
  description: '获取服务器当前时间',
  input: z.object({}),
  execute: async () => ({ time: new Date().toISOString() }),
})
```

## 热重载

BFF 用 `fs.watch` 监听工具目录：

- 新建 `.js`/`.ts` 文件 → 自动加载
- 修改已有文件 → 重新加载并覆盖旧工具
- 删除文件 → 从注册表移除（下次重载生效）

防抖 300ms，连续保存不会重复触发。

如果热重载没生效（某些编辑器用 atomic save 会漏事件），重启 BFF 即可。

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 日志显示「跳过 xxx：不是合法的 ToolDefinition」 | 缺少 name 或 execute | 检查必填字段 |
| 日志显示「加载 xxx 失败」 | 语法错误或 import 失败 | 看错误信息，用 `tsc --noEmit` 检查 |
| 工具没出现 | 文件后缀不对 | 只支持 `.js`/`.ts`/`.mjs`/`.cjs`，`.d.ts` 会忽略 |
| 改了没生效 | 热重载漏事件 | 重启 BFF |
| 全局工具不加载 | `~/.agentkit/tools/` 不存在 | 目录不存在时静默跳过，手动创建 |

## 与 Skill 的区别

| | Tool 插件 | Skill |
|---|-----------|-------|
| 目的 | 增加新能力 | 教 Agent 用现有工具完成特定任务 |
| 形态 | 可执行代码 | Prompt 文本 |
| 运行位置 | BFF 进程内 | 作为 system prompt 发给 LLM |
| 适用场景 | 调 API、查数据库、业务逻辑 | 标准化测试流程、特定 App 的操作步骤 |

两者可以配合：Skill 可以引用你写的自定义工具。