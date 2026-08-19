# Android Companion App

Companion App 是一个可选的 Android 应用,通过无障碍服务(AccessibilityService)提供比 `uiautomator dump` 更快、更稳定的屏幕读取和操作能力。

## 为什么需要 Companion

| 对比项 | uiautomator dump(默认) | Companion App |
|--------|----------------------|---------------|
| 速度 | 每次 fork adb 进程,几百 ms~几秒 | 常驻服务读内存,毫秒级 |
| Unicode 输入 | 需安装 ADBKeyBoard | 原生 `ACTION_SET_TEXT` |
| 事件监听 | 不支持 | 支持无障碍事件流 |
| 安装 | 无需安装 | 需手动安装并授权 |
| 稳定性 | 稳定但慢 | 更快,但依赖无障碍服务 |

## 安装

### 1. 编译 APK

```bash
cd companion-android
./gradlew assembleDebug
```

APK 输出在 `app/build/outputs/apk/debug/app-debug.apk`。

### 2. 安装到设备

```bash
adb install -r companion-android/app/build/outputs/apk/debug/app-debug.apk
```

### 3. 开启无障碍服务

1. 打开 App
2. 点击「去设置」
3. 在系统无障碍设置中找到「Agent Kit Companion」
4. 开启开关
5. 返回 App,应显示「HTTP 服务器已启动: 127.0.0.1:7777」

## 启用

在 BFF 的 `.env` 中设置:

```env
COMPANION_ENABLED=1
```

重启 BFF,工具会自动通过 Companion 服务而非 uiautomator dump 操作设备。

## 工作原理

```
BFF 进程                    Android 设备
┌─────────────┐           ┌──────────────────────┐
│ Companion   │──adb forward──▶  CompanionHttpServer  │
│ Provider    │  tcp:7777   │  (127.0.0.1:7777)     │
└─────────────┘           └──────────┬───────────┘
                                     │
                            ┌────────▼───────────┐
                            │ AccessibilityService│
                            │  - 当前窗口根节点   │
                            │  - 事件环形缓冲     │
                            └────────────────────┘
```

BFF 通过 `adb forward` 把设备的 7777 端口映射到本地,然后 HTTP 调用:

- `GET /tree` — 获取当前无障碍树(扁平 JSON)
- `POST /node/:ref/click` — 点击节点
- `POST /node/:ref/text` — 设置文本(支持 Unicode)
- `POST /node/:ref/scroll?direction=forward|backward` — 滚动
- `GET /events?since=<timestamp>` — 获取事件流

## 验证

启用后让 Agent 执行一个简单任务,观察日志中是否有 Companion 相关输出。也可以直接 curl:

```bash
adb forward tcp:7777 tcp:7777
curl http://127.0.0.1:7777/tree | head -c 500
```

## 故障排查

**App 显示「服务未就绪」**
回到系统设置确认无障碍服务已开启。部分设备(小米、华为)需要在电池优化中允许后台运行。

**BFF 报「无法连接 Companion」**
- 确认 App 已启动且服务已开启
- 运行 `adb forward tcp:7777 tcp:7777`
- 用 curl 测试 `http://127.0.0.1:7777/tree`

**节点树为空**
当前没有可访问的窗口(回到桌面试试)。某些 App 禁用了无障碍,此时会回退到坐标操作。

**切换回 uiautomator**
注释掉 `COMPANION_ENABLED=1` 或设为 `0`,重启 BFF。