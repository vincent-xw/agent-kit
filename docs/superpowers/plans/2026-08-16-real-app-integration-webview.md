# 真实 App 集成与 Hybrid WebView 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工具链能操作 App 内嵌的 WebView（Hybrid）：BFF 自动探测设备上的可调试 WebView，通过 CDP 读取 DOM 并操作；同时在 learn-agent-flutter 里新增一个逼真的多页面 Demo 作为验证目标。

**Architecture:** BFF 侧新增一个 CDP 客户端：发现 WebView 的 unix socket → adb forward → HTTP `/json` 拿调试 URL → WebSocket 连接。DOM 经注入 JS 抓取并转成与原生节点同构的列表，供 4 个对称的 `web_*` 工具使用。App 侧新增 `real_demo` 模块（登录/验证码/列表/详情/WebView），用 mock 数据，WebView 加载本地 asset HTML 并显式开启调试。

**Tech Stack:** TypeScript、Node 22 全局 WebSocket、Zod、vitest、Flutter 3.41、`webview_flutter_android` 4.12、`webview_flutter`

## Global Constraints

- BFF 代码在 `examples/flutter-dev-bff`，App 代码在 `/Users/xuewen/ai-lab/project/learn-agent-flutter`。
- WebView 内容作为独立域：新增 4 个 `web_*` 工具，不复用原生 ref 空间。
- CDP 是增强路径：探测不到可调试 WebView 时，`web_*` 工具返回明确错误，提示用 `mobile_snapshot` 的无障碍树。
- 不引入 `ws`/puppeteer/playwright 依赖，用 Node 全局 `WebSocket`。
- `webview_flutter` 调试 API 是 `AndroidWebViewController.enableDebugging(true)`（静态方法，已核实存在于 4.12.0）。
- Demo 关键路径不使用 `Semantics(identifier:)`，靠 text/content-desc 定位，以对齐未改造 App。
- 起点：BFF 198 个测试通过。
- 本仓库 tsconfig 开启 `noUncheckedIndexedAccess`。
- `/proc/net/unix` 每行字段以空格分隔，最后一列是 socket 名；abstract socket 以 `@` 前缀显示，adb forward 的 `localabstract:` 名要去掉 `@`。

---

## File Structure（BFF）

- `examples/flutter-dev-bff/src/services/webview/cdp-client.ts` — WebView 探测、adb forward、CDP WebSocket 通信。
- `examples/flutter-dev-bff/src/services/webview/dom-to-nodes.ts` — 注入 JS 返回的 DOM 数据 → DeviceNode 形状的纯函数。
- `examples/flutter-dev-bff/src/services/webview/web-view-provider.ts` — 把 CdpClient 包成 SnapshotProvider（供 web_* 工具用）。
- `examples/flutter-dev-bff/src/services/adb-client.ts` — 新增 `listWebViewSockets()`。
- `examples/flutter-dev-bff/src/services/webview/cdp-client.test.ts`
- `examples/flutter-dev-bff/src/services/webview/dom-to-nodes.test.ts`
- `examples/flutter-dev-bff/src/flutter-tools.ts` — 新增 `createWebTools(svc)` 并注册。

## File Structure（App）

- `learn-agent-flutter/lib/app/routes.dart` — 加 `realDemo`。
- `learn-agent-flutter/lib/app/app.dart` — 注册路由。
- `learn-agent-flutter/lib/features/real_demo/real_demo_page.dart` — 流程状态机与各子页面。
- `learn-agent-flutter/lib/features/real_demo/mock_data.dart` — 50 条固定数据。
- `learn-agent-flutter/assets/demo_page.html` — H5 表单。
- `learn-agent-flutter/pubspec.yaml` — 加 `webview_flutter` 依赖与 asset 声明。
- `learn-agent-flutter/lib/features/tool_console/tool_console_page.dart` — 加「真实场景 Demo」入口。

---

### Task 1: dom-to-nodes 纯函数

**Files:**
- Create: `examples/flutter-dev-bff/src/services/webview/dom-to-nodes.ts`
- Test: `examples/flutter-dev-bff/src/services/webview/dom-to-nodes.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface DomElement { text?: string; id?: string; ariaLabel?: string; tag: string; rect: {x:number;y:number;width:number;height:number}; clickable: boolean; editable: boolean; scrollable: boolean; enabled: boolean; }`
  - `function domToNodes(elements: DomElement[], options: { devicePixelRatio: number }): { nodes: DeviceNode[] }`
  - ref 从 1 开始连续分配。

- [ ] **Step 1: 写失败的测试**

创建 `dom-to-nodes.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { domToNodes } from './dom-to-nodes.js'
import type { DomElement } from './dom-to-nodes.js'

function el(partial: Partial<DomElement>): DomElement {
  return {
    tag: 'div', rect: { x: 0, y: 0, width: 100, height: 40 },
    clickable: false, editable: false, scrollable: false, enabled: true, ...partial,
  }
}

describe('domToNodes', () => {
  it('把 DOM 元素转成带连续 ref 的节点', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'button', text: '登录', clickable: true })],
      { devicePixelRatio: 2 },
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.ref).toBe(1)
    expect(nodes[0]!.className).toBe('button')
    expect(nodes[0]!.text).toBe('登录')
    expect(nodes[0]!.clickable).toBe(true)
  })

  it('id 映射为 resourceId，aria-label 映射为 contentDescription', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'input', id: 'username', ariaLabel: '用户名', editable: true })],
      { devicePixelRatio: 1 },
    )
    expect(nodes[0]!.resourceId).toBe('username')
    expect(nodes[0]!.contentDescription).toBe('用户名')
    expect(nodes[0]!.editable).toBe(true)
  })

  it('bounds 按 devicePixelRatio 放大到设备像素', () => {
    const { nodes } = domToNodes(
      [el({ rect: { x: 5, y: 10, width: 50, height: 20 } })],
      { devicePixelRatio: 3 },
    )
    expect(nodes[0]!.bounds).toEqual({ left: 15, top: 30, right: 165, bottom: 90 })
  })

  it('空文本/无 id 时省略可选字段', () => {
    const { nodes } = domToNodes([el({})], { devicePixelRatio: 1 })
    expect(nodes[0]!.text).toBeUndefined()
    expect(nodes[0]!.resourceId).toBeUndefined()
  })

  it('disabled 元素标记 enabled=false', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'button', clickable: true, enabled: false })],
      { devicePixelRatio: 1 },
    )
    expect(nodes[0]!.enabled).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/webview/dom-to-nodes.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `dom-to-nodes.ts`：

```ts
import type { DeviceNode } from '../../types.js'

export interface DomElement {
  text?: string
  id?: string
  ariaLabel?: string
  tag: string
  rect: { x: number; y: number; width: number; height: number }
  clickable: boolean
  editable: boolean
  scrollable: boolean
  enabled: boolean
}

export function domToNodes(
  elements: DomElement[],
  options: { devicePixelRatio: number },
): { nodes: DeviceNode[] } {
  const dpr = options.devicePixelRatio
  const nodes: DeviceNode[] = elements.map((e, i) => {
    const node: DeviceNode = {
      ref: i + 1,
      nodeId: `web:${i + 1}`,
      bounds: {
        left: Math.round(e.rect.x * dpr),
        top: Math.round(e.rect.y * dpr),
        right: Math.round((e.rect.x + e.rect.width) * dpr),
        bottom: Math.round((e.rect.y + e.rect.height) * dpr),
      },
      clickable: e.clickable,
      scrollable: e.scrollable,
      editable: e.editable,
      enabled: e.enabled,
      focused: false,
      className: e.tag,
    }
    if (e.text) node.text = e.text
    if (e.id) node.resourceId = e.id
    if (e.ariaLabel) node.contentDescription = e.ariaLabel
    return node
  })
  return { nodes }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/services/webview/dom-to-nodes.test.ts`
Expected: PASS，5 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add examples/flutter-dev-bff/src/services/webview/dom-to-nodes.ts examples/flutter-dev-bff/src/services/webview/dom-to-nodes.test.ts
git commit -m "feat(webview): DOM 到 DeviceNode 的纯函数转换"
```

---

### Task 3: CdpClient（发现、forward、连接、抓取、输入）

> 依赖 Task 2 的 `listWebViewSockets`，实现时先做 Task 2。

**Files:**
- Create: `examples/flutter-dev-bff/src/services/webview/cdp-client.ts`
- Test: `examples/flutter-dev-bff/src/services/webview/cdp-client.test.ts`

**Interfaces:**
- Consumes: AdbClient 的 `forward/removeForward/shell/listWebViewSockets`（Task 2）；`domToNodes`（Task 1）。
- Produces:
  - `class CdpClient { constructor(adb: AdbClient, options?: { wsFactory?: (url: string) => WebSocket }) {}`
  - `async isAvailable(): Promise<boolean>` — 探测 socket + forward + `/json` 成功。
  - `async snapshot(): Promise<DeviceSnapshot>` — 抓 DOM 并转换。
  - `async tap(ref): Promise<void>`
  - `async setText(ref, text): Promise<void>`
  - `async scroll(ref, direction): Promise<void>`
  - `async dispose(): Promise<void>`
  - 内部维护 ref→backendNodeId 映射。

实现要点（不展开每一行，但必须遵守）：

1. **发现**：`adb.listWebViewSockets()` 取第一个；`adb.forward(localPort, 'localabstract:'+socket)`；`fetch('http://127.0.0.1:'+localPort+'/json')` 取 `type==='page'` 的 `webSocketDebuggerUrl`。
2. **WebSocket 命令**：自增 id，`{id, method, params}`，等响应 id 匹配；`Runtime.evaluate` 返回 `result.result.value`。启用 `DOM`、`Runtime`、`Page` 域（`DOM.enable`/`Runtime.enable`）。
3. **抓 DOM 的注入 JS**（字符串，在设备浏览器里执行）：

```js
(() => {
  const isVisible = el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const isInteractive = el =>
    ['A','BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName) ||
    el.getAttribute('role') === 'button' || el.hasAttribute('onclick') ||
    el.isContentEditable;
  return Array.from(document.querySelectorAll('*'))
    .filter(el => isVisible(el) && (isInteractive(el) || (el.textContent || '').trim()))
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 200),
        id: el.id || undefined,
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('alt') || undefined,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        clickable: isInteractive(el),
        editable: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && !el.disabled,
        scrollable: el.scrollHeight > el.clientHeight,
        enabled: !el.disabled,
        // 关键：把 backendNodeId 挂在元素上，通过 DOM.requestNode 拿到
        __selector: el.id ? '#' + CSS.escape(el.id) : cssPath(el),
      };
    });
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let sel = el.tagName.toLowerCase();
      if (el.parentElement) {
        const same = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el)+1})`;
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
})()
```

4. **坐标点击**：snapshot 已含 bounds，tap 时取 bounds 中心、`Input.dispatchMouseEvent`（mousePressed + mouseReleased）。不依赖 backendNodeId。
5. **设值**：先用 selector 经 `DOM.querySelector`/`DOM.requestNode` 拿 objectId，`Runtime.callFunctionOn` 设 `.value=''` 并 focus，再 `Input.insertText`。
6. **滚动**：`Input.dispatchMouseEvent` type `mouseWheel`。
7. **devicePixelRatio**：`Runtime.evaluate('window.devicePixelRatio')`。
8. **存活检查**：每次操作前 `fetch('/json')` 一次，失败则 dispose 并重新探测。
9. **localPort 分配**：从一个基址（如 9300）递增找空闲端口（尝试 connect ECONNREFUSED 判断）。dispose 时 `adb.removeForward`。

- [ ] **Step 1: 写失败的测试**

用 mock AdbClient + 一个假的 WebSocket 工厂（注入 `wsFactory` 参数到 CdpClient 构造函数，便于测试；生产用 `(url) => new WebSocket(url)`）。覆盖：

- `isAvailable` 在 listWebViewSockets 返回空时为 false
- 发现 socket 后正确 forward 并请求 `/json`，选 type=page
- snapshot 调用注入 JS、把返回交给 domToNodes、bounds 正确
- tap 发两个鼠标事件（pressed/released）在 bounds 中心
- setText 先聚焦清空再 insertText
- dispose 调用 removeForward

```ts
// 关键 mock 形状
const fakeAdb = {
  listWebViewSockets: vi.fn(),
  forward: vi.fn(),
  removeForward: vi.fn(),
} as unknown as AdbClient
// 假 ws：记录发送消息，收到 Runtime.evaluate 时按 payload 回应
```

- [ ] **Step 2: 运行测试确认失败**
Run: `pnpm vitest run src/services/webview/cdp-client.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 CdpClient**
按上述要点实现。注意：WebSocket 消息是异步的，用 `id` 做 promise 配对；连接后等 open。

- [ ] **Step 4: 运行测试确认通过**
Expected: PASS。

- [ ] **Step 5: typecheck 与全量**
Run: `pnpm -r typecheck && pnpm -r test`
Expected: 通过。

- [ ] **Step 6: 提交**
```bash
git add examples/flutter-dev-bff/src/services/webview/cdp-client.ts examples/flutter-dev-bff/src/services/webview/cdp-client.test.ts
git commit -m "feat(webview): CDP 客户端——探测、连接、DOM 抓取与输入"
```

---

### Task 2: AdbClient.listWebViewSockets

> 注意：这个任务在编号上先于 CdpClient，但 CdpClient（Task 3）依赖它。实现时先做本任务再做 Task 3。

**Files:**
- Modify: `examples/flutter-dev-bff/src/services/adb-client.ts`
- Test: `examples/flutter-dev-bff/src/services/adb-client.test.ts`（已存在，追加）

**Interfaces:**
- Produces: `listWebViewSockets(): Promise<string[]>`，返回去掉 `@` 前缀的 abstract socket 名（如 `webview_devtools_remote_12345`）。

- [ ] **Step 1: 在 adb-client.test.ts 追加失败测试**

（该文件已有 `clientWithSpy()` helper，它返回 `{ client, shell }`，shell 是 vi.spyOn。在已有的 describe 块外或内新增一个 describe。）

```ts
describe('listWebViewSockets', () => {
  it('解析 /proc/net/unix 并去掉 @ 前缀', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue([
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_12345',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_67890',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12347 @android_webview_devtools_remote',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12348 @something_else',
    ].join('\n'))
    await expect(client.listWebViewSockets()).resolves.toEqual([
      'webview_devtools_remote_12345',
      'webview_devtools_remote_67890',
    ])
  })
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
  async listWebViewSockets(deviceSerial?: string): Promise<string[]> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    const output = await this.exec(['-s', serial, 'shell', 'cat', '/proc/net/unix'], { timeoutMs: 10_000 })
    const names: string[] = []
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const last = parts[parts.length - 1]
      if (!last || !last.startsWith('@webview_devtools_remote_')) continue
      names.push(last.slice(1))
    }
    return names
  }
```

注意：用 `@webview_devtools_remote_` 精确前缀，排除 `android_webview_devtools_remote`（系统 WebView 的 socket 属于其他进程，通常不是目标 App）和无关 socket。如果真机上发现命名不同，再放宽——但先按精确匹配实现。

- [ ] **Step 4: 测试通过，全量 typecheck**

- [ ] **Step 5: 提交**
```bash
git add examples/flutter-dev-bff/src/services/adb-client.ts examples/flutter-dev-bff/src/services/adb-client.test.ts
git commit -m "feat(adb): listWebViewSockets 解析 /proc/net/unix"
```

---

### Task 4: 4 个 web_* 工具与注册

**Files:**
- Modify: `examples/flutter-dev-bff/src/flutter-tools.ts`
- Modify: `examples/flutter-dev-bff/src/server.ts`（把 CdpClient 注入 services）
- Test: `examples/flutter-dev-bff/src/flutter-tools.test.ts`（若无则新建，用 mock CdpClient）

**Interfaces:**
- Produces: `web_snapshot`、`web_tap`、`web_set_text`、`web_scroll` 四个工具。
- `FlutterToolServices` 增加 `webView: CdpClient`。

- [ ] **Step 1: 写失败的测试**

新建 `flutter-tools.test.ts`，mock 一个 CdpClient（有 isAvailable/snapshot/tap/setText/scroll），验证：
- web_snapshot 不可用时返回 `{ok:false, message}``，错误信息含「未检测到可调试的 WebView」
- 可用时返回节点树
- web_tap/set_text/scroll 转发到 CdpClient

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 在 flutter-tools.ts 加 createWebTools**

```ts
function createWebTools(svc: FlutterToolServices): ToolDefinition[] {
  const unavailable = { ok: false, message: '未检测到可调试的 WebView。该 App 可能未开启 WebView 调试；网页内容可通过 mobile_snapshot 查看无障碍树可见部分。' }
  return [
    {
      name: 'web_snapshot',
      // ...input z.object({}), output 与 mobile_snapshot 同构
      async execute() {
        if (!await svc.webView.isAvailable()) return unavailable
        return svc.webView.snapshot()
      },
    },
    { name: 'web_tap', input z.object({ ref: z.number().int() }),
      async execute(raw) {
        if (!await svc.webView.isAvailable()) return unavailable
        await svc.webView.tap((raw as {ref:number}).ref)
        return { ok: true, message: '已点击网页元素' }
      } },
    // web_set_text、web_scroll 同理
  ]
}
```

把 `createWebTools(svc)` 加进 `createFlutterToolDefinitions` 的展开数组（放在 accessibility tools 之后）。

`FlutterToolServices` 接口加 `webView: CdpClient`。

- [ ] **Step 4: server.ts 构造 CdpClient**

在构造 services 对象处加：
```ts
webView: new CdpClient(adb),
```
import CdpClient。

- [ ] **Step 5: 测试通过 + 全量**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 通过；测试总数增加约 4。

- [ ] **Step 6: 提交**
```bash
git add examples/flutter-dev-bff/src/flutter-tools.ts examples/flutter-dev-bff/src/flutter-tools.test.ts examples/flutter-dev-bff/src/server.ts
git commit -m "feat(webview): 新增 web_snapshot/tap/set_text/scroll 工具"
```

---

### Task 5: App 真实场景 Demo——数据层与登录/验证码页

以下任务在 `/Users/xuewen/ai-lab/project/learn-agent-flutter`。

**Files:**
- Modify: `pubspec.yaml`
- Create: `lib/features/real_demo/mock_data.dart`
- Create: `lib/features/real_demo/real_demo_page.dart`
- Modify: `lib/app/routes.dart`、`lib/app/app.dart`、`lib/features/tool_console/tool_console_page.dart`

**Interfaces:**
- 路由 `/real-demo`，从首页入口进入。
- 一个有状态页面控制流程：login → otp → list → detail。WebView 作为列表页的一个入口按钮。

- [ ] **Step 1: 加依赖**

`flutter pub add webview_flutter`（会自动加 webview_flutter_android）。确认 `pubspec.yaml` 出现：
```yaml
  webview_flutter: ^4.x
```
在 `flutter:` 段加：
```yaml
  assets:
    - assets/demo_page.html
```

- [ ] **Step 2: mock_data.dart**

```dart
class Order {
  final String id;
  final String title;
  final String status; // 全部/进行中/已完成
  final int amount;
  final String detail;
  const Order({required this.id, required this.title, required this.status, required this.amount, required this.detail});
}
const List<Order> kMockOrders = [
  // 50 条，status 轮换，中文 title，amount 随机但固定
];
```
写 50 条固定数据（可用循环生成，只要确定性：index 决定所有字段）。

- [ ] **Step 3: 登录页**

`RealDemoPage` 是 StatefulWidget，`_stage` 枚举（login/otp/list/detail/webview）。

登录页元素（用 Column + TextField + ElevatedButton）：
- TextField「手机号」（keyboardType phone）
- TextField「密码」（obscureText）
- ElevatedButton「登录」：空提交时显示红色 Text「请填写手机号和密码」（用 setState 的 `_loginError`）；非空时进入 otp 阶段
- 不使用 Semantics(identifier:)，靠 TextField 的 decoration labelText 与按钮文字定位

- [ ] **Step 4: 验证码页**

- 一个 Row 含 6 个 Container（每个 40px 方框，显示已输入字符），下方一个真实 TextField（可设 `style: TextStyle(color: Colors.transparent)` 隐藏文字但保持可输入），用 `_otp` 字符串长度渲染方框。autofocus。
- Text「重发验证码（60s）」倒计时，用 Timer.periodic，到 0 变成「重发验证码」可点。
- ElevatedButton「下一步」：otp 长度满 6 才 enabled，点击进入 list。

- [ ] **Step 5: 注册路由和入口**

`routes.dart` 加 `static const String realDemo = '/real-demo';`。
`app.dart` 注册。
首页 AppBar actions 加 TextButton「真实场景」跳该路由（和 Playground 并列）。

- [ ] **Step 6: analyze + 构建**

Run: `flutter analyze`
Expected: No issues found!
Run: `flutter build apk --debug`
Expected: Built。

- [ ] **Step 7: 提交**
```bash
git add pubspec.yaml pubspec.lock lib/assets/ lib/features/real_demo/ lib/app/
git commit -m "feat(real-demo): 登录与短信验证码页，mock 数据"
```

---

### Task 6: 列表、详情、筛选、搜索

**Files:**
- Modify: `lib/features/real_demo/real_demo_page.dart`

- [ ] **Step 1: 列表页**

- AppBar title「我的订单」，底部 Body 是 ListView.builder，itemCount 50，每项 ListTile 显示 title、status、amount。
- 顶部一个 TextField「搜索订单」，onChanged 更新 `_query`，过滤 title.contains。
- 搜索框下方一行 Wrap 含三个 FilterChip：「全部」「进行中」「已完成」，更新 `_statusFilter`。
- 下拉刷新：RefreshIndicator，onRefresh 等 800ms（模拟）后 setState（数据不变也可以，但要触发指示器）。
- 点 ListTile 进入 detail。

- [ ] **Step 2: 详情页**

AppBar 有返回（Navigator.pop 自动）。Body 显示该 Order 的所有字段：id、title、status、amount、detail（一段较长的中文描述）。一个 ElevatedButton「打开帮助中心（H5）」进入 webview 阶段。

- [ ] **Step 3: analyze + build**
Expected: 通过。

- [ ] **Step 4: 提交**
```bash
git add lib/features/real_demo/
git commit -m "feat(real-demo): 列表搜索筛选、下拉刷新与详情页"
```

---

### Task 7: WebView 页 + 本地 H5

**Files:**
- Create: `assets/demo_page.html`
- Modify: `lib/features/real_demo/real_demo_page.dart`

- [ ] **Step 1: demo_page.html**

一个简单 HTML：
- `<input id="h5-username" placeholder="H5 用户名" aria-label="H5 用户名">`
- `<input id="h5-password" type="password" placeholder="H5 密码">`
- `<button id="h5-submit">在网页里登录</button>`
- `<div id="h5-result"></div>`
- 一段内联 JS：点按钮时把用户名写进 result 区。
- meta viewport，body 字体用系统默认。

- [ ] **Step 2: WebView 页**

用 `WebViewController`：
```dart
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
// 在 initState：
if (WebViewPlatform.instance is AndroidWebViewPlatform) {
  AndroidWebViewController.enableDebugging(true);
}
_controller = WebViewController()
  ..setJavaScriptMode(JavaScriptMode.unrestricted)
  ..loadFlutterAsset('assets/demo_page.html');
```
Scaffold body 是 WebViewWidget(controller: _controller)。AppBar title「帮助中心（H5）」。

- [ ] **Step 3: 注册 asset**

确认 pubspec.yaml assets 段含 `- assets/demo_page.html`。

- [ ] **Step 4: analyze + build apk**
Expected: 通过。

- [ ] **Step 5: 提交**
```bash
git add assets/ lib/features/real_demo/ pubspec.yaml
git commit -m "feat(real-demo): WebView 加载本地 H5 并开启调试"
```

---

### Task 8: 真机端到端冒烟（手动，不写代码）

这一步需要设备连着、BFF 配好真实 LLM key、ADBKeyBoard 装好（测中文输入时）。

- [ ] **Step 1: 安装并启动 App**
```bash
cd learn-agent-flutter && flutter install -d <serial> && adb shell monkey -p com.example.learn_agent_flutter -c android.intent.category.LAUNCHER 1
```

- [ ] **Step 2: 验证原生路径**
启动 BFF，在 Web UI 让 Agent：进入真实场景 Demo → 完成登录（任意非空）→ 输入验证码（可让模型输入 6 位数字）→ 在列表搜索一个关键词 → 验证 snapshot 能看到结果。

- [ ] **Step 3: 验证 WebView/CDP 路径**
点进「帮助中心（H5）」。
```bash
adb shell cat /proc/net/unix | grep webview_devtools_remote
```
应能看到 socket。让 Agent 调用 web_snapshot，应返回 H5 的 input/button 节点。让 web_set_text 在 H5 用户名输入「杭州」（若启用了 ADBKeyBoard，CDP 路径直接支持 Unicode，不依赖 IME）。让 web_tap 点登录按钮。

- [ ] **Step 4: 验证回退**
在一个没开调试的 WebView（如有）上调 web_snapshot，应返回明确错误而非崩溃；mobile_snapshot 仍能看到部分内容。

- [ ] **Step 5: 记录问题**
把任何失败的工具/节点/解析问题记下来，作为后续修复或第二轮脏场景的输入。这一步没有提交。

---

## 收尾说明

- 完成后 BFF 工具从 21 增至 25（加 4 个 web_*）。
- 视觉双 LLM（主模型 + 本地多模态截图识别）是独立子系统，不在本计划内，将单独 brainstorm 与 spec。它正好消费本计划的成果：当 web_snapshot/mobile_snapshot 数据不足时，Agent 可调用截图工具→多模态模型→文字描述回灌主 LLM。
- 第二轮「脏场景」（重名按钮、纯图标、缺 label、复杂 WebView 跳转）也在本计划之外，等第一轮真机冒烟后再定。
