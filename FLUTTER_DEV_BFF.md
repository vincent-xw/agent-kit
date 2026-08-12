# Flutter Dev BFF — 设计与进度

## 背景

基于 agent-kit 构建一个 Flutter 开发辅助 Agent，覆盖 Flutter 项目开发测试阶段的日志读取、UI 自动化操作、热重载、静态分析和测试运行。iOS 不在 MVP 范围内（Android 自动化 + iOS 人工补强）。

与已有的 `browser-extension-bff` 完全分离：独立 BFF 进程、独立数据库、独立端口（8788）、内置 Web UI（无需 Chrome 扩展作为 Tool Host）。

---

## 架构概览

### 三层信息通道

| 通道 | 用途 | Phase 1 实现 | Phase 2+ |
|------|------|-------------|----------|
| **Android 无障碍树** | UI 快照、节点操作 | `adb shell uiautomator dump`（零安装） | Companion App（更快、事件流、Unicode 输入） |
| **Dart VM Service** | 热重载、表达式求值、Widget 树 | WebSocket JSON-RPC | 日志流监听 |
| **adb CLI** | 设备管理、截图、坐标输入、app 生命周期 | 直接 execFile | 不变 |

### 与 browser-extension-bff 的关键差异

| 维度 | browser-extension-bff | flutter-dev-bff |
|------|----------------------|-----------------|
| 工具执行 | 全部 `remote`（扩展执行） | 全部 `server`（BFF 直接执行） |
| Tool Host | Chrome 扩展 | BFF 内置 Web UI |
| 工具定义方式 | 扁平数组（无 execute） | 工厂函数注入 services |
| 状态管理 | 无状态 | 有状态（flutter run 进程、VM Service） |
| maxSteps | 10（默认） | 50 |
| 端口 | 8787 | 8788 |

---

## 当前进度（Phase 1-3 已完成）

### 已实现的文件

```
examples/flutter-dev-bff/
├── package.json              # workspace 包，依赖 @agent-kit/*
├── tsconfig.json             # 继承 monorepo 严格配置
├── build.mjs                 # esbuild 打包（复用 browser example 模式）
├── public/
│   └── index.html            # 单文件聊天 Web UI（无框架无构建）
└── src/
    ├── server.ts             # BFF 装配 + 启动 + .env + Web 路由 + 优雅关闭
    ├── server.test.ts        # 鉴权/密钥/工具执行集成测试
    ├── flutter-tools.ts      # 21 个工具定义（工厂函数）
    ├── flutter-tools.test.ts # 工具 schema/结构测试
    ├── prompts.ts            # free-form / debugging / testing 三个 prompt
    ├── types.ts              # 共享类型
    └── services/
        ├── adb-client.ts           # adb CLI 封装
        ├── device-provider.ts      # SnapshotProvider 接口
        ├── uiautomator-provider.ts # uiautomator dump 实现 + XML 解析
        ├── uiautomator-provider.test.ts
        ├── flutter-process-manager.ts  # flutter run 长进程 + 日志环形缓冲
        ├── vm-service-client.ts     # Dart VM Service WebSocket 客户端
        └── screenshot-store.ts      # 截图文件存储 + PNG 尺寸解析
```

### 已实现的 21 个工具

**设备/应用管理（5）：** `mobile_devices`、`mobile_app_install`、`mobile_app_launch`、`mobile_app_stop`、`mobile_screenshot`

**无障碍交互（6）：** `mobile_snapshot`（工具列表第一个）、`mobile_tap_node`、`mobile_set_text`、`mobile_scroll_node`、`mobile_wait_for`、`mobile_press_key`

**坐标降级（2）：** `mobile_tap`、`mobile_swipe`

**Flutter 开发（8）：** `flutter_run_start`、`flutter_run_stop`、`flutter_hot_reload`、`flutter_hot_restart`、`flutter_logs`、`flutter_analyze`、`flutter_test`、`flutter_eval`

### 测试状态

- **19 个测试全部通过**
- 全 monorepo `pnpm -r build` 通过
- 工具 schema 全部可转 JSON Schema
- 鉴权、密钥加密存储、server 工具进程内执行均已验证

---

## 待完成

### Phase 3 收尾（优先级高）

1. **EventBus + SSE 实时进度** — `event-bus.ts` 骨架已写（但在重构中移除了，需要重新加回）。需要：
   - 在工具 execute 外包一层发送 `tool_start`/`tool_end` 事件
   - 添加 SSE 端点 `/api/events/:sessionId`
   - Web UI 接入 EventSource 实时显示工具调用状态
   - 注意：这不能通过修改 agent-kit core 实现，需要在 BFF 层包装

2. **服务层单元测试** — AdbClient、FlutterProcessManager、VmServiceClient 的 mock 测试
3. **.env.example 文件**
4. **README.md** — 启动说明、工具列表、架构说明
5. **真机端到端验证**

### Phase 4：Android Companion App（优先级中）

新建 `companion-android/` 子目录（独立 Gradle/Kotlin 项目）：

- `CompanionAccessibilityService` — 继承 AccessibilityService，持有节点树引用和事件环形缓冲（200 条）
- `NodeTreeDumper` — 递归遍历 `rootInActiveWindow`，输出扁平节点 JSON
- `CompanionHttpServer` — 基于 NanoHTTPD，绑定 `127.0.0.1:7777`
- `MainActivity` — 引导用户开启无障碍权限 + 服务状态显示

**HTTP API：**
- `GET /tree` → 无障碍树 JSON
- `POST /node/:id/click` → `performAction(ACTION_CLICK)`
- `POST /node/:id/text` → `ACTION_SET_TEXT`（支持 Unicode）
- `POST /node/:id/scroll` → `ACTION_SCROLL_FORWARD/BACKWARD`
- `GET /events?since=<ts>` → 无障碍事件流

BFF 侧实现 `CompanionProvider`（实现 `SnapshotProvider` 接口），通过 `COMPANION_ENABLED` 环境变量切换。

**调研结论：** 现有方案中 atx-agent 已归档（2024.5），appium-uiautomator2-server 与 Appium 耦合重。自定义 Kotlin App 开发量约 2-3 天，API 精简可控。

### Phase 5：WebView CDP（优先级低）

Flutter App 内 WebView 的自动化：
- `adb shell cat /proc/net/unix | grep webview_devtools_remote` 发现 WebView
- `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
- CDP WebSocket 连接，复用 browser-extension-bff 的 CDP 工具逻辑

---

## 关键设计决策

1. **SnapshotProvider 接口可替换** — Phase 1 用 uiautomator dump（零安装），Phase 4 换成 Companion App 时工具代码不变
2. **全部 server 工具** — 与 browser example 的 remote 工具不同，Flutter BFF 直接在 BFF 进程执行所有操作
3. **工厂函数注入服务** — `createFlutterToolDefinitions(services)` 而非扁平数组，因为工具需要访问 adb/flutter/vm 等有状态服务
4. **VM Service 优先热重载** — `flutter_hot_reload` 优先用 VM Service `reloadSources`，失败降级到 stdin 'r'
5. **flutter test JSON reporter** — 用 `--reporter json` 解析结构化测试结果，不依赖文本输出格式
6. **截图不返回 base64** — 与 browser_screenshot 同理，存磁盘返回 ID，避免 token 爆炸
7. **优雅关闭** — SIGTERM/SIGINT 时停止 flutter run 进程、关闭数据库
8. **maxSteps=50** — Flutter 开发操作链比浏览器操作长（启动→快照→操作→热重载→再验证）

---

## 启动方式

```bash
cd agent-kit/examples/flutter-dev-bff

# 首次启动会自动生成 .env 模板
# 填写 AGENT_KIT_MASTER_KEY、BFF_API_TOKEN、FLUTTER_PROJECT_PATH、LLM_*
pnpm start

# 打开 http://localhost:8788
```

需要连接 Android 设备或启动模拟器（`adb devices` 可见）。
