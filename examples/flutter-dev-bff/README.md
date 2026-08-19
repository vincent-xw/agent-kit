# Flutter Dev BFF

面向 Flutter 项目开发自测阶段的 Agent 辅助工具。通过 adb 与 Android 无障碍服务操作设备，支持 Flutter 热重载、日志读取、静态分析、测试运行等开发流程。

## 启动方式

```bash
# 1. 安装依赖（在仓库根目录）
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 AGENT_KIT_MASTER_KEY、LLM_API_KEY、FLUTTER_PROJECT_PATH 等

# 3. 开发模式启动（自动 build + watch）
pnpm dev:flutter

# 4. 生产模式启动
pnpm start:flutter
```

打开 http://localhost:8788

## 前置条件

- Android 设备或模拟器已连接（`adb devices` 可见）
- Flutter 项目路径已配置（`FLUTTER_PROJECT_PATH`）
- LLM API Key 已配置（支持 OpenAI 兼容 API）

## 25 个工具

### 设备/应用管理（5 个）
| 工具 | 说明 |
|------|------|
| `mobile_devices` | 列出已连接的 Android 设备 |
| `mobile_app_install` | 安装 APK |
| `mobile_app_launch` | 启动应用 |
| `mobile_app_stop` | 强制停止应用 |
| `mobile_screenshot` | 截取屏幕并保存，用户可见 |

### 无障碍交互（6 个）
| 工具 | 说明 |
|------|------|
| `mobile_snapshot` | 获取当前屏幕节点树（无障碍树），所有 UI 操作的起点 |
| `mobile_tap_node` | 点击指定节点 |
| `mobile_set_text` | 设置文本（支持中文，需 ADBKeyBoard） |
| `mobile_scroll_node` | 滚动指定节点 |
| `mobile_wait_for` | 等待 UI 条件满足 |
| `mobile_press_key` | 发送按键事件 |

### 坐标降级（2 个）
| 工具 | 说明 |
|------|------|
| `mobile_tap` | 坐标点击（无障碍树不可用时使用） |
| `mobile_swipe` | 坐标滑动 |

### 视觉分析（1 个）
| 工具 | 说明 |
|------|------|
| `mobile_screen_analyze` | 截图 + 视觉模型分析，返回文字描述 |

### 网页（WebView/CDP，4 个）
| 工具 | 说明 |
|------|------|
| `web_snapshot` | 获取 WebView 内 DOM 节点 |
| `web_tap` | 点击网页元素 |
| `web_set_text` | 设置网页输入框文本 |
| `web_scroll` | 滚动网页元素 |

### Flutter 开发（7 个）
| 工具 | 说明 |
|------|------|
| `flutter_run_start` | 启动 debug 模式应用，连接 VM Service |
| `flutter_run_stop` | 停止 Flutter 应用 |
| `flutter_hot_reload` | 热重载 |
| `flutter_hot_restart` | 热重启（重置状态） |
| `flutter_logs` | 读取运行日志 |
| `flutter_analyze` | 运行静态分析 |
| `flutter_test` | 运行测试 |

## 三种模式

| 模式 | 系统提示词侧重 |
|------|---------------|
| 自由模式 | 通用 Flutter 开发辅助，全工具可用 |
| 调试模式 | 问题诊断，聚焦日志与 eval |
| 测试模式 | 运行测试与分析失败 |

## 架构

```
┌──────────────────────────────────────────────────┐
│                Web UI (localhost:8788)            │
├──────────────────────────────────────────────────┤
│           Flutter Dev BFF (Node.js)              │
│                                                    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │  ADB Client  │  │  CDP Client  │  │  Vision  │  │
│  │  (uiautomator│  │  (WebView)   │  │  Client  │  │
│  │  /Companion) │  │              │  │          │  │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘  │
│         │                  │               │        │
└─────────┼──────────────────┼───────────────┼────────┘
          │ adb              │ adb forward   │ HTTP
          ▼                  ▼               ▼
   ┌──────────┐     ┌──────────────┐  ┌──────────────┐
   │ Android  │     │ App WebView  │  │  本地视觉    │
   │ 设备     │     │ (CDP)        │  │  模型 API    │
   └──────────┘     └──────────────┘  └──────────────┘
```

## 视觉模型配置

`mobile_screen_analyze` 需要额外配置视觉模型（可选）：

```env
VISION_API_KEY=your-key
VISION_MODEL=your-vision-model
VISION_BASE_URL=http://localhost:11434/v1
```

## Companion App（可选）

用 Android Companion App 替代 uiautomator dump 可提升性能并支持 Unicode 输入：

```env
COMPANION_ENABLED=1
```

## 自定义工具（Tool 插件）

你可以通过在 `tools/` 目录放置 JS/TS 文件来扩展 Agent 能力，无需修改 BFF 源码。插件启动时自动加载，文件保存后自动热重载。

### 快速开始

在项目根目录创建 `tools/weather.ts`：

```ts
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

重启 BFF（或直接保存文件触发热重载），Agent 就能使用 `query_weather` 工具。

### 插件目录

- **项目级**：`<项目根>/tools/*.{js,ts,mjs,cjs}` —— 跟项目走，可提交 git 共享
- **全局级**：`~/.agentkit/tools/*.{js,ts,mjs,cjs}` —— 你自己的工具，所有项目可用

同名工具时优先级：项目级 > 全局级 > 内置。

### 插件能力

插件运行在 Node.js 环境，可以：
- 用全局 `fetch` 调用任何 HTTP API
- 用 `process.env` 读取密钥
- 用 zod 声明 input/output schema
- 返回任意 JSON 可序列化数据

插件**不能**直接访问 adb、截图、CdpClient 等 BFF 内部服务——操作手机的工具都已内置。插件的定位是「给 Agent 装上业务能力」（查订单、调内部系统、控制 IoT 等）。

### 输出校验

`output` schema 可选。声明了就用 zod 校验返回值，不声明则透传。

### 故障排查

- 插件没加载：查看 BFF 启动日志，`[tool-loader]` 开头的 warn 会说明原因
- 改了没生效：确认文件后缀是 `.js`/`.ts`/`.mjs`/`.cjs`（`.d.ts` 会被忽略）
- 热重载不工作：某些编辑器的 atomic save 会触发 unlink+rename，可能漏事件，重启 BFF 即可

Companion App 源码在 `companion-android/` 目录，需用 Android Studio 编译安装。