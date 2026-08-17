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

Companion App 源码在 `companion-android/` 目录，需用 Android Studio 编译安装。