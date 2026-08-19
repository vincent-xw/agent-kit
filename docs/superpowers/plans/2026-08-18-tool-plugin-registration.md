# 用户自定义工具注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过在 tools/ 目录放置 JS/TS 文件扩展 Agent 能力，BFF 启动时自动加载，支持文件监听热重载。

**Architecture:** 新增 ToolLoader 扫描全局和项目级 tools/ 目录，动态 import 默认导出的 ToolDefinition，校验后与内置工具合并。fs.watch 监听目录变化，防抖后重新扫描并通过 runtime.tools.register 覆盖更新。defineTool 是 identity 函数，提供类型推断。

**Tech Stack:** TypeScript、Node 22 动态 ESM import、fs.watch、zod、tsx（加载 .ts）

## Global Constraints

- 插件只能访问全局 fetch 和 process.env，不传入 BFF 内部服务实例。
- output schema 可选，声明则校验。
- 同名工具优先级：项目级 > 全局级 > 内置。
- 单个插件加载失败只 warn，不阻塞 BFF。
- 内置工具与插件工具都经过 instrumentTools 产生 SSE 事件。

---

### Task 1: defineTool 导出

**Files:**
- Create: `examples/flutter-dev-bff/src/define-tool.ts`
- Modify: `examples/flutter-dev-bff/package.json`（exports 字段）

**Interfaces:**
- Produces: `defineTool(def: ToolDefinition): ToolDefinition`

- [ ] **Step 1: 写 define-tool.ts**

```ts
import type { ToolDefinition } from '@agent-kit/core'

/**
 * 定义一个用户自定义工具。identity 函数，仅用于 TypeScript 类型推断。
 * 插件文件默认导出此函数的返回值。
 */
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}
```

- [ ] **Step 2: 在 package.json 加 exports**

在 `exports` 字段加：
```json
"./define": "./dist/define-tool.js"
```

- [ ] **Step 3: typecheck**

Run: `cd examples/flutter-dev-bff && pnpm typecheck`
Expected: 通过

- [ ] **Step 4: commit**

```bash
git add examples/flutter-dev-bff/src/define-tool.ts examples/flutter-dev-bff/package.json
git commit -m "feat: defineTool identity 函数用于插件类型推断"
```

---

### Task 2: ToolLoader 扫描与加载

**Files:**
- Create: `examples/flutter-dev-bff/src/services/tool-loader.ts`
- Test: `examples/flutter-dev-bff/src/services/tool-loader.test.ts`

**Interfaces:**
- Consumes: `defineTool` 导出的 ToolDefinition
- Produces:
  - `class ToolLoader`
  - `constructor(options: { globalDir?: string; projectDir?: string })`
  - `loadAll(): Promise<ToolDefinition[]>`
  - 静态方法校验：`isValidTool(obj: unknown): obj is ToolDefinition`

- [ ] **Step 1: 写失败的测试**

创建 `src/services/tool-loader.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolLoader } from './tool-loader.js'
import { z } from 'zod'

describe('ToolLoader', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tools-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('加载 .js 插件文件', async () => {
    writeFileSync(join(tmp, 'hello.js'), `
      export default {
        name: 'say_hello',
        description: 'say hi',
        input: { parse: (v) => v },
        execute: async () => ({ ok: true, message: 'hi' }),
      }
    `)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('say_hello')
  })

  it('加载 .ts 插件文件', async () => {
    writeFileSync(join(tmp, 'weather.ts'), `
      import { z } from 'zod'
      export default {
        name: 'query_weather',
        description: 'query weather',
        input: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp: 25 }),
      }
    `)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools[0]!.name).toBe('query_weather')
    const result = await tools[0]!.execute({ city: '杭州' })
    expect(result).toEqual({ city: '杭州', temp: 25 })
  })

  it('跳过没有默认导出的文件', async () => {
    writeFileSync(join(tmp, 'bad.js'), `export const x = 1`)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })

  it('跳过缺少 name 或 execute 的非法插件', async () => {
    writeFileSync(join(tmp, 'bad.js'), `export default { description: 'no name' }`)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })

  it('项目级工具覆盖全局级同名工具', async () => {
    const global = mkdtempSync(join(tmpdir(), 'gtools-'))
    mkdirSync(global, { recursive: true })
    writeFileSync(join(global, 'same.js'), `
      export default { name: 'same', description: 'global', input:{parse:v=>v}, execute: async () => 'global' }
    `)
    writeFileSync(join(tmp, 'same.js'), `
      export default { name: 'same', description: 'project', input:{parse:v=>v}, execute: async () => 'project' }
    `)
    const loader = new ToolLoader({ globalDir: global, projectDir: tmp })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(1)
    expect(await tools[0]!.execute({})).toBe('project')
    rmSync(global, { recursive: true, force: true })
  })

  it('目录不存在时静默返回空数组', async () => {
    const loader = new ToolLoader({ projectDir: join(tmp, 'nonexistent') })
    const tools = await loader.loadAll()
    expect(tools).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/tool-loader.test.ts`
Expected: FAIL，找不到 ToolLoader

- [ ] **Step 3: 实现 ToolLoader**

创建 `src/services/tool-loader.ts`：

```ts
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '@agent-kit/core'

const PLUGIN_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs'])

/**
 * 判断一个对象是否是合法的 ToolDefinition。
 * 用 duck typing：有 name 字符串、description 字符串、execute 函数。
 * input schema 不强制要求（部分工具可能无参数）。
 */
export function isValidTool(obj: unknown): obj is ToolDefinition {
  if (!obj || typeof obj !== 'object') return false
  const t = obj as Record<string, unknown>
  return (
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    (typeof t.description === 'string' || t.description === undefined) &&
    typeof t.execute === 'function'
  )
}

export interface ToolLoaderOptions {
  /** 全局工具目录，通常是 ~/.agentkit/tools */
  globalDir?: string
  /** 项目级工具目录，通常是 <cwd>/tools */
  projectDir?: string
}

export class ToolLoader {
  constructor(private options: ToolLoaderOptions = {}) {}

  /**
   * 扫描目录并加载所有插件。
   * 项目级工具排在前面，合并时会覆盖全局同名工具。
   */
  async loadAll(): Promise<ToolDefinition[]> {
    const global = await this.loadFromDir(this.options.globalDir)
    const project = await this.loadFromDir(this.options.projectDir)
    // 项目级后入 Map 覆盖全局级
    const map = new Map<string, ToolDefinition>()
    for (const t of global) map.set(t.name, t)
    for (const t of project) map.set(t.name, t)
    return [...map.values()]
  }

  private async loadFromDir(dir?: string): Promise<ToolDefinition[]> {
    if (!dir || !existsSync(dir)) return []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const tools: ToolDefinition[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!PLUGIN_EXTENSIONS.has(extname(entry.name))) continue
      // 跳过 .d.ts
      if (entry.name.endsWith('.d.ts')) continue
      const file = join(dir, entry.name)
      try {
        // 时间戳 query bust ESM 缓存，文件修改后能重新加载
        const url = pathToFileURL(file).href + '?t=' + Date.now()
        const mod = await import(url)
        const exported = mod.default ?? mod
        if (isValidTool(exported)) {
          tools.push(exported)
        } else {
          console.warn(`[tool-loader] 跳过 ${entry.name}：不是合法的 ToolDefinition`)
        }
      } catch (error) {
        console.warn(`[tool-loader] 加载 ${entry.name} 失败：`, error instanceof Error ? error.message : error)
      }
    }
    return tools
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/tool-loader.test.ts`
Expected: 6 个测试全过

- [ ] **Step 5: commit**

```bash
git add examples/flutter-dev-bff/src/services/tool-loader.ts examples/flutter-dev-bff/src/services/tool-loader.test.ts
git commit -m "feat: ToolLoader 扫描加载 JS/TS 工具插件"
```

---

### Task 3: 集成到 BFF 启动流程

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`

**Interfaces:**
- Consumes: `ToolLoader.loadAll()`
- Produces: 内置工具 + 插件工具合并后的 toolDefinitions

- [ ] **Step 1: 加 import 和 ToolLoader 初始化**

在 server.ts 顶部 import 区加：

```ts
import { ToolLoader } from './services/tool-loader.js'
import { homedir } from 'node:os'
```

在 `const adb = new AdbClient()` 之后、`const device = ...` 附近，加载插件工具：

```ts
  // 加载用户自定义工具插件（全局 ~/.agentkit/tools + 项目 ./tools）
  const globalToolsDir = join(homedir(), '.agentkit', 'tools')
  const projectToolsDir = join(process.cwd(), 'tools')
  const toolLoader = new ToolLoader({ globalDir: globalToolsDir, projectDir: projectToolsDir })
  const pluginTools = await toolLoader.loadAll()
  if (pluginTools.length > 0) {
    audit.log?.(`加载了 ${pluginTools.length} 个用户工具插件：${pluginTools.map((t) => t.name).join(', ')}`)
  }
```

- [ ] **Step 2: 合并到 toolDefinitions**

找到 `const toolDefinitions = createFlutterToolDefinitions({ ... })`，在其后加：

```ts
  // 插件工具追加到内置工具之后（同名时插件已在 loadAll 中覆盖逻辑处理，
  // 这里用 Map 确保最终列表里同名以插件为准）
  const allTools = [...toolDefinitions, ...pluginTools]
  const toolMap = new Map(allTools.map((t) => [t.name, t]))
  const finalTools = [...toolMap.values()]
```

然后把后续所有引用 `toolDefinitions` 的地方改为 `finalTools`（instrumentTools、runtime.tools.register、generateSkill 等）。

- [ ] **Step 3: 加 toolLoader 到返回值**

在 `return { app, runtime, database, prompts, adb, flutter, bus, ready }` 中加：

```ts
    toolLoader,
```

- [ ] **Step 4: typecheck + build**

Run: `cd examples/flutter-dev-bff && pnpm typecheck && pnpm build`
Expected: 通过

- [ ] **Step 5: 手动验证加载**

创建一个临时插件测试：
```bash
mkdir -p /tmp/test-tools
cat > /tmp/test-tools/echo.js << 'EOF'
export default {
  name: 'echo_test',
  description: 'echo back input',
  input: { parse: (v) => v },
  execute: async (input) => ({ echo: input })
}
EOF
```
在 `/tmp/test-tools` 目录下启动 BFF（需要把 projectToolsDir 临时指向这里，或直接放到 ./tools），看日志是否打印「加载了 1 个用户工具插件」。

- [ ] **Step 6: commit**

```bash
git add examples/flutter-dev-bff/src/server.ts
git commit -m "feat: BFF 启动时加载用户工具插件并合并到工具列表"
```

---

### Task 4: 文件监听热重载

**Files:**
- Modify: `examples/flutter-dev-bff/src/services/tool-loader.ts`（加 watch）
- Modify: `examples/flutter-dev-bff/src/server.ts`（监听变化后更新 runtime）
- Test: `examples/flutter-dev-bff/src/services/tool-loader.test.ts`（加重载测试）

**Interfaces:**
- Produces:
  - `ToolLoader.watch(onChange: (tools: ToolDefinition[]) => void): () => void`
  - 返回取消监听函数

- [ ] **Step 1: 写失败的测试**

在 tool-loader.test.ts 末尾加：

```ts
  it('watch 在文件变化后触发回调', async () => {
    const file = join(tmp, 'dynamic.js')
    writeFileSync(file, `export default { name: 'v1', description: 'v1', input:{parse:v=>v}, execute: async () => 'v1' }`)
    const loader = new ToolLoader({ projectDir: tmp })
    const tools1 = await loader.loadAll()
    expect(tools1[0]!.name).toBe('v1')

    // 用 Promise + 超时等待回调
    const changed = new Promise<ToolDefinition[]>((resolve) => {
      const stop = loader.watch((tools) => {
        stop()
        resolve(tools)
      })
    })

    // 等 watcher 就绪后写新文件
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(file, `export default { name: 'v2', description: 'v2', input:{parse:v=>v}, execute: async () => 'v2' }`)

    const tools2 = await Promise.race([changed, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))])
    expect(tools2[0]!.name).toBe('v2')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/tool-loader.test.ts`
Expected: FAIL，ToolLoader 没有 watch 方法

- [ ] **Step 3: 实现 watch**

在 ToolLoader 类中加：

```ts
  private watchers: import('node:fs').FSWatcher[] = []

  /**
   * 监听工具目录变化，防抖后重新加载并调用 onChange。
   * 返回取消监听函数。
   */
  watch(onChange: (tools: ToolDefinition[]) => void): () => void {
    const dirs = [this.options.globalDir, this.options.projectDir].filter(
      (d): d is string => !!d && existsSync(d),
    )
    let timer: NodeJS.Timeout | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const tools = await this.loadAll()
        onChange(tools)
      }, 300)
    }
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: false }, (_event, filename) => {
          if (!filename) return
          const ext = extname(filename)
          if (!PLUGIN_EXTENSIONS.has(ext) || filename.endsWith('.d.ts')) return
          reload()
        })
        this.watchers.push(w)
      } catch (error) {
        console.warn(`[tool-loader] 监听 ${dir} 失败：`, error instanceof Error ? error.message : error)
      }
    }
    return () => this.stopWatching()
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
  }
```

在文件顶部 import 加 `watch`：
```ts
import { readdir, stat, watch } from 'node:fs/promises'
```

- [ ] **Step 4: 在 server.ts 接线**

在 Task 3 创建 toolLoader 之后，注册 watch：

```ts
  // 热重载：工具目录变化时更新 runtime
  const stopWatchingTools = toolLoader.watch(async (newTools) => {
    try {
      const merged = new Map([...finalTools, ...newTools].map((t) => [t.name, t]))
      for (const tool of merged.values()) {
        runtime.tools.register(tool)
      }
      audit.log?.(`工具已热重载，当前 ${merged.size} 个工具`)
      bus.emit({ type: 'tools_reloaded', count: merged.size() })
    } catch (error) {
      audit.log?.(`工具热重载失败：${error instanceof Error ? error.message : error}`)
    }
  })
```

注意：`finalTools` 需要是可变的（let 而非 const），或在 watch 回调内重新读取。把 Task 3 的 `const finalTools` 改为 `let finalTools`，在回调中更新。

在进程退出时停止监听：加一个 `process.once('SIGTERM', stopWatchingTools)` 和 `process.once('SIGINT', stopWatchingTools)`。

- [ ] **Step 5: 运行测试**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/tool-loader.test.ts`
Expected: 7 个测试全过

- [ ] **Step 6: typecheck + build**

Run: `cd examples/flutter-dev-bff && pnpm typecheck && pnpm build`
Expected: 通过

- [ ] **Step 7: commit**

```bash
git add examples/flutter-dev-bff/src/services/tool-loader.ts examples/flutter-dev-bff/src/services/tool-loader.test.ts examples/flutter-dev-bff/src/server.ts
git commit -m "feat: 工具目录文件监听热重载，变更后自动更新 runtime"
```

---

### Task 5: 文档

**Files:**
- Modify: `examples/flutter-dev-bff/README.md`
- Create: `examples/flutter-dev-bff/tools/.gitkeep`

- [ ] **Step 1: 创建 tools 目录占位**

```bash
mkdir -p examples/flutter-dev-bff/tools
touch examples/flutter-dev-bff/tools/.gitkeep
```

- [ ] **Step 2: 在 README 加「自定义工具」章节**

在 README 末尾加：

```markdown
## 自定义工具（Tool 插件）

你可以通过在 `tools/` 目录放置 JS/TS 文件来扩展 Agent 能力，无需修改 BFF 源码。插件会在启动时自动加载，文件修改后自动热重载。

### 快速开始

在 `tools/weather.ts` 创建：

\`\`\`ts
import { defineTool } from '@agentkit/flutter-dev-bff/define'
import { z } from 'zod'

export default defineTool({
  name: 'query_weather',
  description: '查询指定城市的当前天气',
  input: z.object({ city: z.string() }),
  output: z.object({ temp: z.number() }).optional(),
  execute: async ({ city }) => {
    const res = await fetch(\`https://api.weather.com/?q=\${city}&key=\${process.env.WEATHER_API_KEY}\`)
    return res.json()
  },
})
\`\`\`

重启 BFF（或直接保存文件触发热重载），Agent 就能使用 \`query_weather\` 工具。

### 插件目录

- **项目级**：`<项目根>/tools/*.{js,ts}` —— 跟项目走，可提交 git 共享
- **全局级**：`~/.agentkit/tools/*.{js,ts}` —— 你自己的工具，所有项目可用

同名工具时项目级覆盖全局级，插件覆盖内置工具。

### 插件能做什么

插件运行在 Node.js 环境，可以：
- 用全局 \`fetch\` 调用任何 HTTP API
- 用 \`process.env\` 读取密钥
- 用 zod 声明 input/output schema
- 返回任意 JSON 可序列化数据

插件**不能**直接访问 adb、截图、CdpClient 等 BFF 内部服务——操作手机的工具都已内置。插件的定位是「给 Agent 装上业务能力」（查订单、调内部系统、控制 IoT 等）。

### 输出校验

\`output\` schema 可选。声明了就用 zod 校验返回值，不声明则透传。

### 故障排查

- 插件没加载：看 BFF 启动日志，\`[tool-loader]\` 开头的 warn 会说明原因
- 改了没生效：确认文件后缀是 .js/.ts/.mjs/.cjs（.d.ts 会被忽略）
- 热重载不工作：某些编辑器的 atomic save 会触发 unlink+rename，可能漏事件，重启 BFF 即可
```

- [ ] **Step 3: commit**

```bash
git add examples/flutter-dev-bff/README.md examples/flutter-dev-bff/tools/.gitkeep
git commit -m "docs: 自定义工具插件文档与 tools 目录占位"
```