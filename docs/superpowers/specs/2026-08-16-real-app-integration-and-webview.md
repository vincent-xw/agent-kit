# 真实 App 集成形态与 Hybrid WebView 支持

## 目标

回答两个问题：(1) 这套工具未来以什么形式操作未改造的真实 App；(2) 在目标 App 暂缺时，用逼真的 Demo 验证工具链，并补齐 App 内 WebView（Hybrid）场景的自动化能力。

本设计覆盖 BFF 侧的 WebView CDP 探测与 web_* 工具，以及 learn-agent-flutter 侧的真实场景 Demo。两部分通过设备上的 WebView 调试 socket 协作。

## 背景：零改造的集成形态

通用 UI 工具通过 adb + Android 无障碍服务操作**任意 App**，目标 App 无需配合。当前解析器提取的 `text`、`resource-id`、`class`、`content-desc`、布尔标志与 bounds 均为标准无障碍属性，未改造的原生控件默认暴露。样板页中使用的 `Semantics(identifier:)` 仅用于让测试更确定，不是使用前提——Flutter 引擎本就会为可交互控件设置 `Button`/`EditText`/`ScrollView` 等具体 className（已由真机 `uiautomator dump` 确认）。

21 个工具分为两类：

- **通用工具（14 个）**：`mobile_devices`、`mobile_app_install`、`mobile_app_launch`、`mobile_app_stop`、`mobile_screenshot`、`mobile_snapshot`、`mobile_tap_node`、`mobile_set_text`、`mobile_scroll_node`、`mobile_wait_for`、`mobile_press_key`、`mobile_tap`、`mobile_swipe`、`flutter_logs`。对任意 App 工作。
- **Flutter 开发期工具（7 个）**：`flutter_run_start`、`flutter_run_stop`、`flutter_hot_reload`、`flutter_hot_restart`、`flutter_analyze`、`flutter_test`、`flutter_eval`。仅在开发某个 Flutter 项目时使用，不参与真实 App 集成。

因此「集成到其他 App」本质是：BFF 通过 adb 与无障碍服务操作该 App，App 端零代码。

## WebView 的两条路径

Android 对 WebView 内容有两种可观测方式，二者互补：

- **无障碍树（通用回退）**：多数 WebView 会把部分 DOM 映射进系统无障碍树。无需 App 配合，对第三方发布版也生效，但拿不到完整 DOM，交互粒度粗。
- **Chrome DevTools Protocol（增强）**：精确读取 DOM、执行 JS、派发输入事件。**硬约束**：宿主 App 必须调用 `WebView.setWebContentsDebuggingEnabled(true)`，CDP 端口才会暴露。第三方发布版通常不开。

设计采用两条路都做、自动探测切换：无障碍树始终可用；探测到 CDP 可用时启用更精确的 web_* 工具。

## 架构：WebView 作为独立域

不复用原生节点模型。WebView 内容是另一个世界（DOM 而非无障碍节点、CDP 而非 adb input），把它拍平进 `DeviceNode` 会丢失边界且让 ref 歧义。改为：

- `mobile_snapshot` 返回原生无障碍树；当屏幕上存在 WebView 时，在结果里附加一个**特殊标记节点**，告诉 Agent 可以切换：

  ```
  { ref: <n>, text: "WebView（可切换到网页模式）", clickable: true, className: "android.webkit.WebView" }
  ```

  不新增 `_webview` 之类的非 schema 字段——标记节点本身用 `className === "android.webkit.WebView"` 识别，保持 `DeviceNode` 形状不变。

- 新增 4 个对称的 web 工具，各自独立的 ref 空间：
  - `web_snapshot` — 通过 CDP 抓取 DOM 并转换为节点列表（形状对齐 `DeviceNode`，但来自 DOM）。
  - `web_tap(ref)` — 通过 CDP 点击。
  - `web_set_text(ref, text)` — 通过 CDP 聚焦并设值。
  - `web_scroll(ref, direction)` — 通过 CDP 滚动。

  先只做这 4 个。`web_wait_for`、`web_press_key` 留待真机验证后按需添加（YAGNI）。

- Agent 看到原生快照里的 WebView 标记节点后，可调用 `web_snapshot` 进入网页模式；操作完用原生工具回到 App。切换是 Agent 决策，BFF 不维护「当前域」状态（无状态更简单，且能处理一屏多个 WebView 的边缘情况——`web_snapshot` 默认连当前可见的那个）。

## CDP 探测与连接

探测流程（懒执行，不在每次 snapshot 都跑）：

1. `adb shell cat /proc/net/unix | grep webview_devtools_remote` 发现 abstract socket（形如 `webview_devtools_remote_<pid>`）。
2. 选一个：优先之前连过且仍存活的；否则取列表第一个。
3. `adb forward tcp:<本地端口> localabstract:<socket>`。
4. `GET http://localhost:<端口>/json` 拿到可调试页面列表，取 `type === "page"` 的 `webSocketDebuggerUrl`。
5. 通过全局 `WebSocket`（Node 22+ 内置，不引入 ws 依赖）连接。

转发与连接缓存：维护 `{ serial, localPort, socket, ws, pid }`。每次 web 工具调用前做一次轻量存活检查（`/json` 能否返回、socket 是否仍在 `/proc/net/unix` 中）；失效则拆掉重连。BFF 进程退出时 `adb forward --remove`。

探测不到时：web 工具返回明确错误——「未检测到可调试的 WebView。该 App 可能未开启 WebView 调试；网页内容可通过 mobile_snapshot 查看无障碍树可见部分」。

### CDP 输入操作

- **web_tap**：根据 ref 拿到 backendNodeId，先 `DOM.scrollIntoViewIfNeeded`，再 `DOM.getBoxModel` 取中心点，最后 `Input.dispatchMouseEvent`（mousePressed + mouseReleased）。这样不依赖元素 CSS 选择器，且对坐标命中一致。
- **web_set_text**：`DOM.scrollIntoViewIfNeeded` 后 `Input.dispatchMouseEvent` 聚焦，`Input.insertText` 设值（先全选删除：Ctrl+A + Delete via `Input.dispatchKeyEvent`）。Unicode 直接支持，不像 adb input text。
- **web_scroll**：`Input.dispatchMouseEvent`（mouseWheel）按方向派发。

### DOM → 节点转换

CDP 用 `Runtime.evaluate` 注入一段 JS，遍历整棵 DOM 树（`document.querySelectorAll('*')` 后逐个判定），对每个**可见且可交互或有文本**的元素提取：

- `text`：`textContent` 截断
- `resourceId`：元素 `id`
- `contentDescription`：`aria-label` 或 `alt`
- `className`：标签名
- `bounds`：`getBoundingClientRect()` 转设备像素（乘以 `devicePixelRatio`）
- `clickable`：`<a>/<button>/<input role=button>` 或带 `onclick`
- `editable`：`<input>/<textarea>/[contenteditable]` 且非 disabled
- `scrollable`：`scrollHeight > clientHeight`
- `enabled`：未带 `disabled`

ref 用一个递增 id，并在 BFF 侧维护 `ref → { frame: number, backendNodeId }` 的映射，供 tap/set_text 使用。每次 `web_snapshot` 重建映射。不直接信任前端传的 selector，用 backendNodeId 经 `DOM.resolveNode` + `Input.dispatch*` 操作。

## 逼真 Demo（learn-agent-flutter）

在现有项目新增 `lib/features/real_demo/`，注册路由 `/real-demo`，不改现有代码。关键路径**不使用 `Semantics(identifier:)`**，强迫工具链依赖真实可见的 text/content-desc 定位，与未改造 App 对齐。

用 mock 数据，不依赖后端：

1. **登录页**：账号输入、密码输入、登录按钮。空提交显示红字错误（SnackBar 或内联文案），任意非空输入「登录成功」进入下一步。
2. **短信验证码页**：6 个输入格、「重发验证码（Ns）」倒计时、下一步按钮。倒计时到 0 可重发（不真发短信）。
3. **列表页**：搜索框、筛选 chips（如「全部/进行中/已完成」）、50 条 mock 数据、下拉刷新、点击进入详情。返回键回到列表。
4. **详情页**：展示该条目的完整字段，有返回。
5. **WebView 页**：用 `webview_flutter` 加载 `asset:assets/demo_page.html`，并在初始化时调用 `WebView.platform`（Android）开启 `setWebContentsDebuggingEnabled(true)`。本地 HTML 含一个简单的 H5 表单（输入框 + 提交按钮），用于验证 CDP 操作。

本地 HTML 放 `assets/demo_page.html`，行为确定、不依赖网络、真机必能加载。

列表数据用固定 50 条，包含中文文案与各种状态，便于验证滚动与筛选。

## 组件边界

**BFF 侧（agent-kit/examples/flutter-dev-bff）：**

- 新增 `src/services/webview/cdp-client.ts` — CDP 发现、forward、WebSocket、DOM 抓取与输入。
- 新增 `src/services/webview/dom-to-nodes.ts` — DOM → 节点形状的纯函数（便于单测）。
- 新增 4 个 `web_*` 工具，与现有 mobile 工具并列。
- AdbClient 已有 `forward` / `removeForward`，新增一个 `listWebViewSockets(): Promise<string[]>`（读 `/proc/net/unix`）。

**App 侧（learn-agent-flutter）：**

- `lib/features/real_demo/` 新目录，纯 UI + mock 数据。
- `assets/demo_page.html`。
- `pubspec.yaml` 加 `webview_flutter` 依赖。

## 测试策略

- `dom-to-nodes.ts`：纯函数单测，喂各种 DOM 片段验证映射与边界。
- `cdp-client.ts`：mock adb 与 WebSocket（注入假的 `/json` 响应与 WS 消息），验证发现、forward、重连、错误路径。
- 4 个 web 工具：mock CdpClient 验证入参与错误传播。
- 现有 198 个测试保持通过。
- Demo 不写 widget test（验收标准是被 BFF 驱动）。

## 范围之外

- 一屏多个 WebView 的选择 UI（默认取可见的那个；真遇到再加）。
- iOS WebView（WKWebView 的 Web Inspector 机制不同，且需要 macOS + 设备关联）。
- `web_wait_for` / `web_press_key`（YAGNI，真机后按需）。
- 第三方 App 未开调试时对 WebView 内容的精确操作——这是平台限制，只能靠无障碍树看可见部分。
- 对 `webview_flutter` 之外的 WebView 实现（Crosswalk、X5 等）做适配。
