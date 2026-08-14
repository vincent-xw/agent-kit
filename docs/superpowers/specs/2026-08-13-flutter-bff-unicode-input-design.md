# Flutter Dev BFF：中文/Unicode 文本输入

## 目标

让 `mobile_set_text` 兑现它自己已经声明的契约：替换而非追加、支持中文等非 ASCII 字符。

实现方式是接入 ADBKeyBoard 输入法的 base64 广播通道，并在 Web UI 提供一键安装启用。

## 背景：工具描述与实现不符

[flutter-tools.ts:183](../../../examples/flutter-dev-bff/src/flutter-tools.ts:183) 的描述：

> 向可编辑节点设置文本（替换原有内容）。优先使用此工具输入文本，它支持中文等非 ASCII 字符。

两项承诺均未兑现：

1. **声明「替换原有内容」，实际是追加。** [uiautomator-provider.ts:161](../../../examples/flutter-dev-bff/src/services/uiautomator-provider.ts:161) 先发 `KEYCODE_MOVE_END` 把光标移到末尾，再输入文本，结果是在原内容后追加。
2. **声明「支持中文」，实际非 ASCII 直接失败。** 同文件 `:163` 处的 ASCII 正则校验不通过即返回 `ok: false`。

[prompts.ts:21](../../../examples/flutter-dev-bff/src/prompts.ts:21) 又写着「中文等非 ASCII 文本输入依赖设备 Companion App」，与工具描述自相矛盾。模型读到工具描述后会认为中文可用，尝试后得到失败。

因此这不是新增功能，而是让实现与契约一致。两项都是缺陷。

## 背景：ASCII 路径存在命令注入面

[adb-client.ts:115](../../../examples/flutter-dev-bff/src/services/adb-client.ts:115) 的 `inputText` 把文本拼入 `adb shell input text`。`AdbClient` 用 `execFile` 传数组参数，本机不经过 shell，但 `adb shell` 到设备端仍由设备的 shell 解释命令行。文本中的 `;`、`&&`、反引号、`$()` 会被设备 shell 执行。

此处的文本来自模型生成的工具参数，属于可控性较低的输入源。

base64 编码顺带消除该问题：base64 字母表仅含 `A-Za-z0-9+/=`，不含任何 shell 元字符。这是选择 `ADB_INPUT_B64` 而非 `ADB_INPUT_TEXT` 的第二个理由；第一个理由是上游 README 指出纯文本广播在 Oreo/P 上存在 UTF-8 问题。

## 为什么必须依赖外部输入法

`adb shell input text` 不支持 Unicode，这是 adb 的能力边界，非实现缺陷。已排除的替代路径：

- **剪贴板注入**：新版 Android 限制剪贴板写入需前台应用，`service call clipboard` 跨版本不可靠。
- **逐字符 keyevent**：只能覆盖 ASCII 可映射键位。
- **Dart VM Service 直接设值**：BFF 已持有 VM Service 连接，理论可改 TextField 的 controller，但在 widget 树中精确定位目标输入框不可靠，且仅对 Flutter 应用有效。

因此只有两条路：第三方输入法，或 Phase 4 自建 Companion App（无障碍服务的 `ACTION_SET_TEXT` 原生支持 Unicode）。本设计取前者作为当前方案，两者不冲突——`SnapshotProvider` 是可替换接口，Companion App 上线后本段逻辑自然被替代。

## 设计决策

### 探测「当前激活」输入法，而非「已启用」列表

`adb shell ime list -s` 列出的是已启用的输入法。ADBKeyBoard 的广播只在它是**当前激活**输入法时生效——它需要持有 InputConnection 才能把文本提交进焦点输入框。

以 `ime list -s` 判断会产生假阳性：输入法已启用但未激活时，探测报告可用，实际输入静默失败。

改用：

```bash
adb shell settings get secure default_input_method
```

比对返回值是否为 `com.android.adbkeyboard/.AdbIME`。需 trim 换行；部分设备可能返回空字符串或 `null`。

### 不缓存探测结果

每次 `setText` 多一次 adb 往返（约 50–100ms）。`setText` 不是热路径，该开销可接受。

缓存有害：用户在 BFF 运行期间安装并启用输入法后，缓存会持续报告「不可用」。

### 输入法可用时，ASCII 也走 base64

同一条代码路径处理全部文本，减少分支组合；并顺带消除 ASCII 路径的注入面。代价是多一次广播，可忽略。

### 不自动切换输入法，但提供一键安装

切换默认输入法是全局操作，会影响用户在该设备上的日常打字。BFF 不得在用户不知情时修改设备状态。

但通过 Web UI 的显式点击执行安装与切换是可接受的——**点击即授权**，与静默修改性质不同。

### 记录并可还原原输入法

一键安装会切换默认输入法。用户需要在该设备上正常打字，切换后必须能切回，且通常不记得原本是哪个输入法。

因此 `ime-setup` 端点在切换前读取并返回原输入法 id，UI 展示该 id 并提供还原入口。

### APK 由用户自行获取，不内置、不联网下载

ADBKeyBoard 使用 GPL-2.0 许可，发布资产为 `keyboardservice-debug.apk`（debug 签名，用于测试设备无妨）。

内置到仓库会使 agent-kit 成为 GPL-2.0 二进制的分发者，需自行承担随附源码等合规义务。运行时下载则引入网络依赖与哈希维护负担（上游发新版即失配）。

改由用户手动下载一次，通过 `.env` 的 `ADBKEYBOARD_APK_PATH` 指定路径。agent-kit 既不分发 GPL 二进制也不联网。

## 组件设计

### AdbClient 新增方法

```
getDefaultIme(): Promise<string>
  settings get secure default_input_method，返回值已 trim

enableIme(imeId: string): Promise<void>
  ime enable <imeId>

setIme(imeId: string): Promise<void>
  ime set <imeId>

clearTextViaIme(): Promise<void>
  am broadcast -a ADB_CLEAR_TEXT

inputTextViaIme(text: string): Promise<void>
  文本 base64 编码后 am broadcast -a ADB_INPUT_B64 --es msg <base64>
```

安装复用已有的 `install(apkPath)`。

### setText 重写

```
1. 校验 ref 有效、节点 editable
2. tap 节点中心聚焦
3. 探测当前激活输入法
4. 分支：
   ├─ ADBKeyBoard 已激活
   │    clearTextViaIme() → inputTextViaIme(text)
   ├─ 未激活 且 文本为 ASCII
   │    KEYCODE_MOVE_END → 发 node.text.length 次 KEYCODE_DEL → inputText(text)
   └─ 未激活 且 含非 ASCII
        返回 ok:false，message 含安装指引
```

降级路径的清空次数取自快照中已有的 `node.text` 长度，无需额外查询设备。

非 ASCII 且输入法未激活时的错误消息须包含完整命令：

```
adb install <你的路径>/keyboardservice-debug.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
adb shell ime set com.android.adbkeyboard/.AdbIME
```

### 新增端点

三者均沿用现有 Bearer token 鉴权。

```
GET /api/ime-status
  → { activeIme, isAdbKeyboard, apkPathConfigured }

POST /api/ime-setup
  → install → enable → set
  → { ok, previousIme, activeIme }

POST /api/ime-restore   body: { imeId }
  → ime set <imeId>
  → { ok, activeIme }
```

`previousIme` 由 Web UI 存入 localStorage，还原时回传给 `ime-restore`。服务端不持有该状态——BFF 重启或页面刷新都不应丢失还原能力，而把它放在服务端内存反而会丢。

`ADBKEYBOARD_APK_PATH` 未配置时，`ime-status` 返回 `apkPathConfigured: false`，UI 提示配置路径而非展示安装按钮。

安装后输入法可能需要短暂时间才出现在系统列表中，`ime-setup` 在 `enable` 失败时重试一次。

### Web UI

页面加载时请求 `ime-status`，按状态显示顶部横幅：

- 未激活且已配置 APK 路径：`⚠ 未检测到 ADBKeyBoard，中文输入不可用` + 一键安装并启用按钮
- 未激活且未配置路径：提示在 `.env` 中配置 `ADBKEYBOARD_APK_PATH`
- 已激活：`✓ ADBKeyBoard 已激活（原输入法：<id>）` + 还原按钮

原输入法 id 从 localStorage 读取。若 localStorage 中没有（例如换了浏览器，或输入法是用户手动切换的），只显示已激活状态，不显示还原按钮——不猜测该还原成哪个。

无设备连接时 `ime-status` 无法探测，横幅不显示，不阻塞页面。

### 文案修正

- [prompts.ts:21](../../../examples/flutter-dev-bff/src/prompts.ts:21) 关于「依赖 Companion App」的说明改为 ADBKeyBoard。
- [flutter-tools.ts:183](../../../examples/flutter-dev-bff/src/flutter-tools.ts:183) 的描述改为如实表述：中文输入需设备已启用 ADBKeyBoard，失败时错误信息含配置指引。

## 测试策略

沿用 `uiautomator-provider.test.ts` 中手写 mock 对象的模式，新增方法补入 mock。

setText：

- 输入法已激活 + 中文 → 调用 `clearTextViaIme` 与 `inputTextViaIme`，**未调用** `inputText`
- 输入法已激活 + ASCII → 同样走 base64 路径
- 未激活 + ASCII → 走 `KEYCODE_MOVE_END` + `KEYCODE_DEL`×N + `inputText`
- 未激活 + 中文 → 返回 `ok:false`，message 含三条安装命令
- 清空调用发生在输入调用之前（顺序断言）
- 中文文本的 base64 编码结果正确
- `default_input_method` 返回空字符串或 `null` 时不抛异常，按未激活处理
- ref 失效、节点非 editable → 各自的错误

端点：

- 三个端点无 token 返回 401
- `ime-status` 在未配置 APK 路径时返回 `apkPathConfigured: false`
- `ime-setup` 返回切换前的 `previousIme`

现有 171 个测试须保持通过。

## 范围之外

- 内置 APK 或运行时下载。
- 自动切换输入法（仅经 UI 显式点击执行）。
- Phase 4 Companion App。
- `mobile_set_text` 之外的工具。
