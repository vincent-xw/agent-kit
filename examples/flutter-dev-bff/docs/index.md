# Flutter Dev BFF 使用指南

Flutter Dev BFF 是一个面向 Flutter 项目开发自测阶段的 AI Agent 辅助工具。它通过 adb 和 Android 无障碍服务操作连接的设备,支持 UI 自动化、热重载、日志读取、静态分析、测试运行,并可通过 WebView CDP 操作 H5 页面、通过视觉模型分析屏幕截图。

## 快速开始

### 1. 前置条件

- Node.js 22+
- pnpm
- Android SDK(adb 在 PATH 中)
- 一台已连接的 Android 设备或模拟器(`adb devices` 可见)
- 一个 LLM API Key(OpenAI 兼容接口,如 DeepSeek)

### 2. 安装与配置

```bash
# 在仓库根目录
pnpm install

# 进入 BFF 目录
cd examples/flutter-dev-bff
cp .env.example .env
```

编辑 `.env`,至少填写:

```env
AGENT_KIT_MASTER_KEY=<openssl rand -base64 32 | tr +/ -_ | tr -d =>
BFF_API_TOKEN=dev-token
FLUTTER_PROJECT_PATH=/path/to/your/flutter/app
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com
```

### 3. 启动

```bash
# 开发模式(自动 build + watch)
pnpm dev:flutter

# 或生产模式
pnpm start:flutter
```

打开 http://localhost:8788

### 4. 第一次使用

在输入框输入:

> 启动应用,检查首页是否正常显示

Agent 会自动:
1. 调用 `mobile_devices` 确认设备连接
2. 调用 `flutter_run_start` 启动 debug 应用
3. 调用 `mobile_snapshot` 读取当前界面
4. 返回中文总结

## 功能概览

| 能力 | 工具 | 说明 |
|------|------|------|
| 设备管理 | `mobile_devices`、`mobile_app_*` | 列出设备、安装、启动、停止应用 |
| UI 自动化 | `mobile_snapshot`、`mobile_tap_node`、`mobile_set_text` 等 | 基于无障碍树,支持中文输入 |
| 坐标降级 | `mobile_tap`、`mobile_swipe` | 无障碍树不可用时使用 |
| 视觉分析 | `mobile_screen_analyze` | 截图送多模态模型,返回文字描述 |
| WebView | `web_snapshot`、`web_tap` 等 | 通过 CDP 操作 H5 页面 |
| Flutter 开发 | `flutter_run_*`、`flutter_hot_*`、`flutter_logs`、`flutter_eval` | 热重载、日志、Dart 表达式 |
| 静态分析/测试 | `flutter_analyze`、`flutter_test` | 运行 analyze 和 test |
| 自定义扩展 | Tool 插件 | 在 `tools/` 目录放 JS/TS 文件扩展能力 |

## 文档索引

- [工具参考](tools.md) — 全部 25 个工具的详细说明
- [Skill 系统](skills.md) — 用大白话生成可复用流程
- [配置说明](settings.md) — 环境变量、视觉模型、Companion App
- [自定义工具](custom-tools.md) — 开发自己的工具插件
- [Companion App](companion.md) — 更快的无障碍服务(可选)

## 常见问题

**Agent 说找不到设备?**
运行 `adb devices` 确认设备已连接且授权。无线调试需先 `adb connect`。

**中文输入失败?**
需要安装 ADBKeyBoard 输入法,运行 `pnpm ime:setup`。ASCII 文本无需此输入法。

**热重载不生效?**
先确认 `flutter_run_start` 已成功启动(VM Service 已连接)。如果状态异常,用 `flutter_hot_restart` 重置。

**Agent 看不到截图?**
Agent 本身不能看图,需要用 `mobile_screen_analyze` 把截图发给视觉模型转成文字。配置见 [配置说明](settings.md)。