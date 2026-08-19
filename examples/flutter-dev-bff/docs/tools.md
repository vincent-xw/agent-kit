# 工具参考

Flutter Dev BFF 内置 25 个工具,按功能分为 7 组。

## 设备与应用管理

### mobile_devices

列出已连接的 Android 设备。

- **输入**:无(可选 `deviceSerial`)
- **返回**:设备序列号、型号、状态

### mobile_app_install

安装 APK 到设备。

- **输入**:`apkPath`(本地路径)
- **返回**:安装结果

### mobile_app_launch

启动应用。

- **输入**:`packageName`(可选,默认当前 Flutter 项目的包名)
- **返回**:启动结果

### mobile_app_stop

强制停止应用。

- **输入**:`packageName`
- **返回**:停止结果

### mobile_screenshot

截取设备屏幕并保存为 PNG。截图对用户可见,但 Agent 看不到图片内容(需配合 `mobile_screen_analyze`)。

- **输入**:可选 `deviceSerial`
- **返回**:`screenshotId`、宽高、提示信息

## 无障碍交互(优先使用)

### mobile_snapshot

获取当前屏幕的无障碍节点树。这是所有 UI 操作的起点——Agent 应先调用此工具看清屏幕,再决定操作。

- **输入**:可选 `deviceSerial`
- **返回**:`snapshotId`、节点数组
- **节点字段**:`ref`(操作引用)、`text`、`hint`(输入框占位提示)、`contentDescription`、`className`、`resourceId`、`bounds`、`clickable`、`scrollable`、`editable`、`enabled`、`checked`、`selected`

### mobile_tap_node

点击无障碍树中的节点。

- **输入**:`ref`(来自 snapshot)
- **返回**:操作结果

### mobile_set_text

设置输入框文本。支持中文等非 ASCII 字符(需 ADBKeyBoard 输入法)。

- **输入**:`ref`、`text`
- **返回**:操作结果

### mobile_scroll_node

滚动可滚动节点。

- **输入**:`ref`、`direction`(`forward`/`backward`)
- **返回**:操作结果

### mobile_wait_for

等待异步 UI 变化(loading 消失、元素出现等)。

- **输入**:`ref`、`condition`(`exists`/`not_exists`/`text_contains`/`clickable`)、`timeoutMs`
- **返回**:`satisfied`(布尔值)、耗时

超时返回 `satisfied: false` 不是错误,重新快照评估即可。

### mobile_press_key

发送 Android 按键事件(返回键、Home 键等)。

- **输入**:`keyCode` 或预定义键名(`back`/`home`/`enter`/`tab`)
- **返回**:操作结果

## 坐标操作(降级使用)

仅当无障碍树中找不到目标时使用。

### mobile_tap

按屏幕坐标点击。

- **输入**:`x`、`y`
- **返回**:操作结果

### mobile_swipe

从一个坐标滑动到另一个坐标。

- **输入**:`x1`、`y1`、`x2`、`y2`、可选 `durationMs`
- **返回**:操作结果

## 视觉分析

### mobile_screen_analyze

截图并调用视觉模型(多模态 LLM)分析屏幕内容,返回文字描述。

- **输入**:可选 `deviceSerial`
- **返回**:`ok`、`description`(文字描述)
- **适用场景**:
  - 无障碍树节点稀疏(大量图标、自定义 View、图片)
  - 页面背景复杂,节点信息不足
  - 需要理解整体布局和视觉内容
- **注意**:描述中不含可点击 ref,需结合 `mobile_snapshot` 使用

## WebView(H5 页面)

当 `mobile_snapshot` 返回 `className` 为 `android.webkit.WebView` 的节点时,说明屏幕上有网页内容。

### web_snapshot

获取 WebView 内 DOM 节点树。

- **输入**:无
- **返回**:`snapshotId`、节点数组(结构与 mobile_snapshot 类似)
- **前置条件**:App 开启了 WebView 调试(debug 模式默认开启)

### web_tap

点击网页元素。

- **输入**:`ref`(来自 web_snapshot)
- **返回**:操作结果

### web_set_text

设置网页输入框文本。

- **输入**:`ref`、`text`
- **返回**:操作结果

### web_scroll

滚动网页元素。

- **输入**:`ref`、`direction`
- **返回**:操作结果

## Flutter 开发

### flutter_run_start

以 debug 模式启动 Flutter 应用,自动连接 VM Service。

- **输入**:可选 `deviceId`、`flavor`、`dartDefines`
- **返回**:VM Service URI、应用信息

### flutter_run_stop

停止 Flutter 应用。

### flutter_hot_reload

触发热重载(R)。代码修改后调用,然后重新快照验证 UI 变化。

- **返回**:重载结果

### flutter_hot_restart

触发热重启(Shift+R),重置应用状态。热重载不生效时使用。

### flutter_logs

读取应用运行日志。

- **输入**:可选 `lines`(默认 100)、`filter`
- **返回**:日志行数组

### flutter_eval

在运行的 Flutter 应用中执行 Dart 表达式。

- **输入**:`expression`(Dart 表达式)
- **返回**:求值结果
- **常用表达式**:
  - `debugDumpApp()` — 打印 Widget 树(结果在日志中)
  - `WidgetsBinding.instance.renderViewElement.toStringDeep()` — 返回 Widget 树字符串
  - 访问全局变量、调用静态方法

### flutter_analyze

运行 `flutter analyze` 检查静态问题。

- **返回**:问题列表

### flutter_test

运行 Flutter 测试。

- **输入**:可选 `target`(测试文件路径)、`timeoutMs`(默认 5 分钟)
- **返回**:通过/失败数、失败详情

## 工具选择原则

1. **先 snapshot 再操作** — 不要猜测控件名称或坐标
2. **优先节点操作** — 用 `mobile_tap_node` 而非 `mobile_tap`,无障碍树更稳定
3. **网页用 web 工具** — 看到 WebView 节点时切换到 `web_snapshot`
4. **操作后验证** — 工具返回 ok 只表示命令已发送,重新 snapshot 确认 UI 响应
5. **信息不足时用视觉** — snapshot 节点稀疏时调 `mobile_screen_analyze`
6. **不假装成功** — 工具报错时读取错误信息并调整策略