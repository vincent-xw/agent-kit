# 双 LLM 视觉识图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent 增加「看图」能力：当无障碍树数据不足时，Agent 调用 `mobile_screen_analyze`，BFF 截图送本地多模态模型，返回文字描述回灌主 LLM。

**Architecture:** 视觉模型包装成普通工具，不改 core harness。新增 `VisionClient` 发 HTTP 请求到本地多模态模型（OpenAI 兼容 API）。`FlutterToolServices` 增加可选 `vision` 字段，`createFlutterDevBff` 增加 `VISION_*` 配置参数。

**Tech Stack:** TypeScript、Node 22 全局 `fetch`、Zod、vitest

## Global Constraints

- 只修改 `examples/flutter-dev-bff`。不得改动 `packages/` 下任何基础模块。
- 视觉模型配置通过 `VISION_API_KEY`、`VISION_BASE_URL`、`VISION_MODEL` 三个环境变量传入，与主 LLM 完全分离。
- 未配置 `VISION_*` 时工具返回 `ok: false`，不崩溃。
- 视觉模型输出为自由文本描述，不包含坐标或结构化节点。
- 起点：198 个测试通过。每个任务结束时 `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。

---

## File Structure

- `examples/flutter-dev-bff/src/services/vision-client.ts` — 新建。OpenAI 兼容 HTTP 客户端，发送 base64 截图并解析文字描述。
- `examples/flutter-dev-bff/src/services/vision-client.test.ts` — 新建。
- `examples/flutter-dev-bff/src/flutter-tools.ts` — 修改。`FlutterToolServices` 加 `vision?: VisionClient`；`createDeviceTools` 加 `mobile_screen_analyze` 工具。
- `examples/flutter-dev-bff/src/server.ts` — 修改。`createFlutterDevBff` 接受 `VISION_*` 参数，条件创建 `VisionClient` 并注入。主模块读取环境变量。
- `examples/flutter-dev-bff/src/prompts.ts` — 修改。`freeFormPrompt` 加视觉模型使用说明。

---

### Task 1: VisionClient

**Files:**
- Create: `examples/flutter-dev-bff/src/services/vision-client.ts`
- Test: `examples/flutter-dev-bff/src/services/vision-client.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `VisionClientConfig { apiKey: string; baseUrl: string; model: string }`
  - `class VisionClient { constructor(config: VisionClientConfig)`
  - `async analyze(imageBase64: string): Promise<string>`

- [ ] **Step 1: 写失败的测试**

创建 `src/services/vision-client.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { VisionClient } from './vision-client.js'

const config = { apiKey: 'sk-test', baseUrl: 'http://localhost:11434/v1', model: 'qwen-vl' }

function mockFetch(response: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  })) as unknown as typeof fetch
}

describe('VisionClient', () => {
  it('发送 base64 图片并返回文字描述', async () => {
    const client = new VisionClient(config, { fetchImpl: mockFetch({
      choices: [{ message: { content: '屏幕上有一个登录按钮和两个输入框' } }],
    }) })
    const result = await client.analyze('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    expect(result).toBe('屏幕上有一个登录按钮和两个输入框')
  })

  it('请求体包含 model、messages 和 max_tokens', async () => {
    const fetch = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    const client = new VisionClient(config, { fetchImpl: fetch })
    await client.analyze('dGVzdA==')
    const call = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1]?.body as string)
    expect(body.model).toBe('qwen-vl')
    expect(body.max_tokens).toBe(500)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content[0].type).toBe('text')
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('HTTP 非 2xx 抛出错误', async () => {
    const client = new VisionClient(config, { fetchImpl: mockFetch({ error: 'unauthorized' }, 401) })
    await expect(client.analyze('x')).rejects.toThrow(/401|unauthorized/)
  })

  it('网络错误抛出', async () => {
    const client = new VisionClient(config, { fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED') }) })
    await expect(client.analyze('x')).rejects.toThrow(/connect ECONNREFUSED/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/vision-client.test.ts`
Expected: FAIL，报找不到模块。

- [ ] **Step 3: 实现 VisionClient**

创建 `src/services/vision-client.ts`：

```ts
export interface VisionClientConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export class VisionClient {
  constructor(
    private config: VisionClientConfig,
    private options: { fetchImpl?: typeof fetch } = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  async analyze(imageBase64: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`
    const body = {
      model: this.config.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请描述这个手机屏幕上的内容，包括所有可见的UI元素、文字、按钮和输入框。注意屏幕上的中文内容，按从上到下的顺序描述。简短描述，不超过200字。',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
          ],
        },
      ],
      max_tokens: 500,
    }

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`视觉模型请求失败: HTTP ${response.status} ${text.slice(0, 200)}`)
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('视觉模型响应缺少 choices[0].message.content')
    return content
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/vision-client.test.ts`
Expected: PASS，4 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/services/vision-client.ts examples/flutter-dev-bff/src/services/vision-client.test.ts
git commit -m "feat: VisionClient——OpenAI 兼容格式的视觉模型 HTTP 客户端
移动端用截图 base64 传给本地多模态模型，返回文字描述。请求体包含
text+image_url 多模态 content，超时 25 秒。可注入 fetchImpl 便于测试。"
```

---

### Task 2: 工具注册与服务端装配

**Files:**
- Modify: `examples/flutter-dev-bff/src/flutter-tools.ts`（接口 + 工具定义）
- Modify: `examples/flutter-dev-bff/src/server.ts`（配置参数 + 注入）
- Test: 已有测试文件（验证未配置时工具报错）

**Interfaces:**
- Consumes: Task 1 的 `VisionClient`。
- Produces: `mobile_screen_analyze` 工具。

- [ ] **Step 1: 加可选 vision 字段到 FlutterToolServices**

在 `src/flutter-tools.ts` 的 `FlutterToolServices` 接口中，`webView` 之后加：

```ts
  /** 视觉模型客户端，用于截图分析。未配置时此字段为 undefined。 */
  vision?: VisionClient
```

- [ ] **Step 2: 加 mobile_screen_analyze 工具**

在 `createDeviceTools` 的 `mobile_screenshot` 工具之后追加：

```ts
    {
      name: 'mobile_screen_analyze',
      execution: 'server',
      description:
        '截图并调用视觉模型分析屏幕内容，返回文字描述。当 mobile_snapshot 返回的节点较少或没有有用信息时使用（例如页面含有大量图标、图片、自定义绘制控件）。描述中不包含可点击的 ref，需要结合 mobile_snapshot 的节点信息一起判断。',
      input: z.object({
        deviceSerial: z.string().optional(),
      }),
      output: z.object({
        ok: z.boolean(),
        description: z.string().optional(),
        message: z.string(),
      }),
      timeoutMs: 30_000,
      async execute(raw) {
        if (!svc.vision) {
          return { ok: false, message: '未配置视觉模型。请设置 VISION_API_KEY、VISION_MODEL 和 VISION_BASE_URL 环境变量。' }
        }
        const { deviceSerial } = raw as { deviceSerial?: string }
        const buffer = await svc.adb.screenshot(deviceSerial)
        const base64 = buffer.toString('base64')
        const description = await svc.vision.analyze(base64)
        return { ok: true, description, message: '截图已分析' }
      },
    },
```

- [ ] **Step 3: createFlutterDevBff 接受 VISION_* 参数**

在 `src/server.ts` 的 `createFlutterDevBff` 选项类型中，`llmMaxRetries` 之后加：

```ts
  vision?: VisionClientConfig
```

在 import 段加：

```ts
import { VisionClient } from './services/vision-client.js'
import type { VisionClientConfig } from './services/vision-client.js'
```

在 `const toolDefinitions = createFlutterToolDefinitions({ ... })` 调用中，`webView` 之后加：

```ts
    ...(options.vision ? { vision: new VisionClient(options.vision) } : {}),
```

- [ ] **Step 4: 主模块读取 VISION_* 环境变量**

在 `src/server.ts` 的主模块块中，找到 `const port = Number(process.env.PORT ?? '8788')`，在其后加：

```ts
  const vision =
    process.env.VISION_API_KEY && process.env.VISION_MODEL && process.env.VISION_BASE_URL
      ? { apiKey: process.env.VISION_API_KEY, baseUrl: process.env.VISION_BASE_URL, model: process.env.VISION_MODEL }
      : undefined
  if (vision) console.log(`[flutter-bff] 视觉模型已配置: ${vision.model}`)
```

在 `createFlutterDevBff` 调用中，`llmTrace` 之后加：

```ts
    ...(vision ? { vision } : {}),
```

- [ ] **Step 5: 验证未配置时工具报错**

Run: `cd examples/flutter-dev-bff && pnpm test`（不设 VISION_*，BFF 可用但工具报错）
Expected: 全部通过，无 `VISION_*` 相关错误。

- [ ] **Step 6: 验证 typecheck**

Run: `cd examples/flutter-dev-bff && pnpm typecheck`
Expected: 通过。

- [ ] **Step 7: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功，测试数 202（198 + 4）。

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/src/flutter-tools.ts examples/flutter-dev-bff/src/server.ts
git commit -m "feat: 新增 mobile_screen_analyze 工具，截图送视觉模型分析
注册在 createDeviceTools 中。vision 字段为可选，未配置时工具返回
ok:false 不崩溃。VISION_* 环境变量与主 LLM 配置完全分离。"
```

---

### Task 3: 提示词更新

**Files:**
- Modify: `examples/flutter-dev-bff/src/prompts.ts`

- [ ] **Step 1: 在 freeFormPrompt 末尾加视觉模型说明**

在 `freeFormPrompt` 的「注意事项」段中，最后一个条目之后追加：

```ts
  '- 当 mobile_snapshot 返回的节点较少或没有有用信息时，调用 mobile_screen_analyze 获取屏幕截图的分析描述。该工具会截图并调用视觉模型分析屏幕内容，返回文字描述。描述中不包含可点击的 ref，需要结合 mobile_snapshot 的节点信息一起判断。',
```

- [ ] **Step 2: 提交**

```bash
git add examples/flutter-dev-bff/src/prompts.ts
git commit -m "feat(prompts): 自由模式提示词加 mobile_screen_analyze 使用说明"
```