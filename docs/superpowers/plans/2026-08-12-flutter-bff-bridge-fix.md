# Flutter Dev BFF 桥接层修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `@hono/node-server` 替换 `flutter-dev-bff` 手写的 Node↔Hono 桥接，修复截图 PNG 二进制损坏，并把服务显式绑定到 loopback。

**Architecture:** 当前 `src/server.ts` 用 `createServer` + `res.end(await response.text())` 手工桥接，把响应体按 UTF-8 文本解码，破坏二进制。改用官方适配器 `serve()`，二进制与流式响应由适配器处理。为使桥接可被测试，把启动逻辑从模块级 `if` 块中提取为导出函数。

**Tech Stack:** TypeScript (ESM)、Hono 4.8.5、`@hono/node-server` 2.1.0、vitest 3.2.4、Node `node:sqlite`

## Global Constraints

- `@hono/node-server` 版本 `^2.1.0`（peer dep 要求 `hono: ^4`，本仓库为 4.8.5，兼容）。
- 只修改 `examples/flutter-dev-bff`。不得改动 `packages/` 下任何基础模块，不得改动 `examples/browser-extension-bff`。
- 本计划**不包含** EventBus / SSE / Web UI 改造。SSE 部分的 spec 待按取消设计修订后另行实施。
- 收尾必须通过 `pnpm -r typecheck && pnpm -r test && pnpm -r build`，现有 145 个测试全部保持通过。
- 现有测试使用 Hono 的 `app.request()` 辅助方法，它**完全绕过 Node 桥接**——这正是缺陷未被发现的原因。因此本计划的回归测试必须启动真实监听端口并通过 `fetch` 走真实 HTTP。

---

## File Structure

- `examples/flutter-dev-bff/package.json` — 新增 `@hono/node-server` 生产依赖。
- `examples/flutter-dev-bff/src/server.ts` — 删除手写桥接（`readBody`、`createServer` 块），新增导出的启动函数 `startFlutterDevBffServer`，主模块块改为调用它。
- `examples/flutter-dev-bff/src/bridge.test.ts` — 新建。真实 HTTP 往返测试：PNG 字节一致性、绑定地址。与现有 `server.test.ts` 分开，因为它需要启停真实服务器，生命周期管理与那些进程内测试不同。

---

### Task 1: 用 @hono/node-server 替换手写桥接，修复 PNG 损坏

**Files:**
- Modify: `examples/flutter-dev-bff/package.json`（dependencies 段）
- Modify: `examples/flutter-dev-bff/src/server.ts:1-6`（imports）、`:155-162`（删除 `readBody`）、`:263-290`（替换 `createServer` 块）
- Test: `examples/flutter-dev-bff/src/bridge.test.ts`（新建）

**Interfaces:**
- Consumes: `createFlutterDevBff(options)` — 已存在，返回 `{ app, runtime, database, prompts, adb, flutter, ready }`。其 `options` 已支持 `screenshotDir`（[server.ts:47](../../../examples/flutter-dev-bff/src/server.ts:47)）与 `databasePath`。
- Produces: `startFlutterDevBffServer(fetchHandler, port): Promise<{ server, port }>` — 供 Task 2 添加 hostname 参数，并供测试启动临时服务器。`server` 具备 `.close()` 与 `.address()`。调用方传入箭头函数包装（`(request) => bff.app.fetch(request)`）而非直接传 `bff.app.fetch`，避免方法脱离 `this` 绑定。

- [ ] **Step 1: 安装依赖**

```bash
cd examples/flutter-dev-bff && pnpm add @hono/node-server@^2.1.0
```

- [ ] **Step 2: 写失败的回归测试**

新建 `examples/flutter-dev-bff/src/bridge.test.ts`。`PNG_BASE64` 是一个真实的 1×1 PNG（69 字节），其首字节 `0x89` 与内部 `0xff` 正是 UTF-8 解码会破坏的值。

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFlutterDevBff, startFlutterDevBffServer } from './server.js'

const masterKey = 'A'.repeat(43)
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function startWithScreenshot(): Promise<{ port: number; png: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'flutter-bff-shot-'))
  const png = Buffer.from(PNG_BASE64, 'base64')
  await writeFile(join(dir, 'shot-test1.png'), png)

  const bff = createFlutterDevBff({
    masterKey,
    apiToken: 'token-1',
    flutterProjectPath: '/tmp/flutter-app',
    databasePath: ':memory:',
    screenshotDir: dir,
  })
  await bff.ready
  const { server, port } = await startFlutterDevBffServer((request) => bff.app.fetch(request), 0)
  cleanups.push(() => {
    server.close()
    bff.database.close()
  })
  return { port, png }
}

describe('flutter-dev-bff HTTP 桥接', () => {
  it('截图 PNG 经真实 HTTP 往返后字节完全一致', async () => {
    const { port, png } = await startWithScreenshot()

    const res = await fetch(`http://127.0.0.1:${port}/api/screenshots/shot-test1`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const received = Buffer.from(await res.arrayBuffer())
    expect(received.length).toBe(png.length)
    expect(received.equals(png)).toBe(true)
  })

  it('JSON 路由经真实 HTTP 仍然正常', async () => {
    const { port } = await startWithScreenshot()

    const res = await fetch(`http://127.0.0.1:${port}/v1/agent/sessions/s-1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })

    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/bridge.test.ts`

Expected: FAIL。`startFlutterDevBffServer` 尚未导出，报错类似 `startFlutterDevBffServer is not a function` 或 TypeScript 报找不到导出。

- [ ] **Step 4: 新增导出的启动函数**

在 `src/server.ts` 顶部 import 段加入：

```ts
import { serve } from '@hono/node-server'
```

在 `createFlutterDevBff` 函数之后、`seedSecret` 之前插入：

```ts
export function startFlutterDevBffServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  port: number,
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: fetchHandler, port }, (info) => {
      resolve({ server, port: info.port })
    })
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/bridge.test.ts`

Expected: PASS，两个测试都通过。PNG 字节一致性证明缺陷已修。

- [ ] **Step 6: 删除手写桥接与死代码**

在 `src/server.ts` 中：

删除 `readBody` 函数（原 [server.ts:155-162](../../../examples/flutter-dev-bff/src/server.ts:155)）。

把主模块块里从 `const server = createServer(...)` 到 `server.listen(port, ...)` 的整段（原 [server.ts:263-279](../../../examples/flutter-dev-bff/src/server.ts:263)）替换为：

```ts
  await bff.ready
  const { server } = await startFlutterDevBffServer((request) => bff.app.fetch(request), port)
  console.log(`Flutter Dev BFF listening on http://localhost:${port}`)
```

删除文件开头的第 1、2 两条 import（`createServer` 与 `IncomingMessage`/`ServerResponse` 类型已无使用者），保留第 3 行的 `DatabaseSync`。删除后文件前两行应为：

```ts
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
```

保留 `shutdown` 中的 `server.close()` 不变。

- [ ] **Step 7: 确认无残留引用并跑全量测试**

Run: `cd examples/flutter-dev-bff && grep -n "createServer\|readBody\|IncomingMessage\|ServerResponse" src/server.ts`

Expected: 无输出。

Run: `pnpm -r typecheck && pnpm -r test`

Expected: typecheck 全过；测试 147 通过（原 145 + 本任务新增 2）。

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/package.json examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/bridge.test.ts pnpm-lock.yaml
git commit -m "fix: 用 @hono/node-server 替换手写桥接，修复截图 PNG 二进制损坏

手写桥接用 res.end(await response.text()) 按 UTF-8 解码响应体，
PNG 首字节 0x89 被替换为 U+FFFD，69 字节变 95 字节。现有测试走
app.request() 绕过桥接，因此未能发现。新增真实 HTTP 往返测试。"
```

---

### Task 2: 显式绑定 127.0.0.1

**Files:**
- Modify: `examples/flutter-dev-bff/src/server.ts`（Task 1 新增的 `startFlutterDevBffServer`）
- Test: `examples/flutter-dev-bff/src/bridge.test.ts`（追加测试）

**Interfaces:**
- Consumes: `startFlutterDevBffServer(fetchHandler, port)` — Task 1 产出。
- Produces: 同一函数，`serve()` 调用中固定 `hostname: '127.0.0.1'`。签名不变。

背景：Node 的 `listen(port)` 不传 host 时绑定 `::`（全部网卡），实测同一局域网内可通过本机地址访问。叠加 `.env` 模板默认的 `BFF_API_TOKEN=dev-token`，同网段他人可连接、观察事件流、操作设备。绑定 loopback 是「不做会话隔离」这一决策的安全前提。

- [ ] **Step 1: 写失败的测试**

在 `src/bridge.test.ts` 的 `describe` 块内追加：

```ts
  it('只绑定 loopback，不监听全部网卡', async () => {
    const bff = createFlutterDevBff({
      masterKey,
      apiToken: 'token-1',
      flutterProjectPath: '/tmp/flutter-app',
      databasePath: ':memory:',
    })
    await bff.ready
    const { server } = await startFlutterDevBffServer((request) => bff.app.fetch(request), 0)
    cleanups.push(() => {
      server.close()
      bff.database.close()
    })

    const address = server.address()
    expect(typeof address).toBe('object')
    expect((address as { address: string }).address).toBe('127.0.0.1')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/bridge.test.ts`

Expected: FAIL。实际 address 是 `::`（或 `0.0.0.0`），断言不等于 `127.0.0.1`。

- [ ] **Step 3: 加上 hostname**

修改 `startFlutterDevBffServer` 中的 `serve()` 调用，显式传入 hostname，不依赖库的默认值：

```ts
    const server = serve({ fetch: fetchHandler, port, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, port: info.port })
    })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/bridge.test.ts`

Expected: PASS，三个测试全过。

- [ ] **Step 5: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`

Expected: 三条命令均成功。测试 148 通过（145 + Task 1 的 2 + 本任务 1）。其中 `examples/browser-extension-bff` 的 26 个测试通过，是插件路径未受影响的证据（见 [AGENTS.md](../../../AGENTS.md)）。

- [ ] **Step 6: 提交**

```bash
git add examples/flutter-dev-bff/src/server.ts examples/flutter-dev-bff/src/bridge.test.ts
git commit -m "fix: BFF 显式绑定 127.0.0.1，不再监听全部网卡

listen(port) 不传 host 时绑定 ::，实测同网段可访问。叠加 .env 模板
默认的弱 token，他人可连接并操作本机设备。绑定 loopback 是不做会话
隔离这一决策的安全前提。"
```

---

## 收尾说明

完成后 `FLUTTER_DEV_BFF.md` 中以下内容已过时，但**不在本计划范围内**，留待 SSE 实施时一并更新：

- `.env.example` 待办项（`ensureEnvTemplate()` 已自动生成 `.env`，该待办无必要）
- `mobile_snapshot`「工具列表第一个」（实际位于数组第 6 位）
- Phase 3 收尾中 SSE 那条描述（需按取消设计修订）

`.env` 模板中 `BFF_API_TOKEN=dev-token` 这一弱默认值本计划不改动。绑定 loopback 后局域网风险已消除，但若日后有人显式改绑 `0.0.0.0`，该默认值会再次成为问题。此依赖关系已记入 spec 的「遗留风险」。
