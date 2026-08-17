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

## 当前进度（Phase 1-5 已完成）

### 已实现的文件

```
examples/flutter-dev-bff/
├── package.json
├── tsconfig.json
├── build.mjs
├── .env.example
├── README.md
├── public/
│   └── index.html            # 单文件聊天 Web UI（设置、Skills、历史、新建会话）
├── scripts/
│   ├── ime-setup.sh          # ADBKeyBoard 安装与启用脚本
│   └── ime-restore.sh        # 还原原输入法
├── skills/                   # Skill 目录（可创建多个 skill）
├── src/
│   ├── server.ts             # BFF 装配 + 启动 + 路由 + 优雅关闭
│   ├── server.test.ts
│   ├── flutter-tools.ts      # 25 个工具定义（工厂函数）
│   ├── flutter-tools.test.ts
│   ├── prompts.ts            # 三个系统提示词
│   ├── types.ts
│   ├── tool-events.ts        # 工具埋点 + SSE 事件
│   ├── tool-events.test.ts
│   └── services/
│       ├── adb-client.ts
│       ├── adb-client.test.ts
│       ├── companion-provider.ts  # Companion App 模式提供者
│       ├── device-provider.ts     # SnapshotProvider 接口
│       ├── event-bus.ts           # SSE 事件总线
│       ├── event-bus.test.ts
│       ├── flutter-process-manager.ts
│       ├── screenshot-store.ts
│       ├── skill-store.ts         # Skill 文件系统存储
│       ├── skill-generator.ts     # LLM 生成/优化 Skill
│       ├── uiautomator-provider.ts
│       ├── uiautomator-provider.test.ts
│       ├── vision-client.ts       # 视觉模型客户端
│       ├── vision-client.test.ts
│       ├── vm-service-client.ts
│       └── webview/
│           ├── cdp-client.ts       # CDP 发现/连接/DOM 抓取
│           ├── cdp-client.test.ts
│           ├── dom-to-nodes.ts     # DOM → DeviceNode 转换
│           └── dom-to-nodes.test.ts
├── companion-android/          # 独立 Kotlin/Android 项目
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   └── app/src/main/java/com/agentkit/companion/
│       ├── CompanionAccessibilityService.kt
│       ├── CompanionHttpServer.kt
│       ├── NodeTreeDumper.kt
│       └── MainActivity.kt
```

### 已实现的 25 个工具

**设备/应用管理（5）：** `mobile_devices`、`mobile_app_install`、`mobile_app_launch`、`mobile_app_stop`、`mobile_screenshot`

**无障碍交互（6）：** `mobile_snapshot`、`mobile_tap_node`、`mobile_set_text`、`mobile_scroll_node`、`mobile_wait_for`、`mobile_press_key`

**坐标降级（2）：** `mobile_tap`、`mobile_swipe`

**视觉分析（1）：** `mobile_screen_analyze`

**网页（WebView/CDP，4）：** `web_snapshot`、`web_tap`、`web_set_text`、`web_scroll`

**Flutter 开发（7）：** `flutter_run_start`、`flutter_run_stop`、`flutter_hot_reload`、`flutter_hot_restart`、`flutter_logs`、`flutter_analyze`、`flutter_test`、`flutter_eval`

### 测试状态

- **88+ 个测试通过**（flutter-dev-bff 88 + core/bff-hono/adapter 等）
- 全 monorepo `pnpm -r build` 通过
- 工具 schema 全部可转 JSON Schema
- 鉴权、密钥加密存储、server 工具进程内执行均已验证

---

## 待完成

### Phase 6：双 LLM 视觉识图（已完成）

`mobile_screen_analyze` 工具已完成，截图送本地多模态模型返回文字描述。
配置见 README.md 的视觉模型配置章节。

### Phase 7：Skill 系统（已完成）

大白话 → LLM 生成 Skill prompt → 用户核验 → 保存 → 一键执行。
支持 Skill 自优化（读历史 → LLM 分析 → 生成新版 prompt）。
Skills 面板含「Skills」「历史」两个标签页。

### 已知问题

- `browser-extension-bff` 有 1 个测试失败（工具输出 Schema 校验），是 main 上预先存在的问题
- Flutter 开发期工具（run/reload/eval/analyze/test）只对 Flutter 项目有效，不适用于通用 App 调试

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
