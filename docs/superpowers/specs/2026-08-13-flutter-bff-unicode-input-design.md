# Flutter Dev BFF：中文/Unicode 文本输入

## 目标

让 `mobile_set_text` 兑现它自己已经声明的契约：替换而非追加、支持中文等非 ASCII 字符。

实现方式是接入 ADBKeyBoard 输入法的 base64 广播通道。设备端的安装与切换由 Bash 脚本完成，不新增端点，不改动 Web UI。

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

### 提示走对话，不改 Web UI

Agent 的聊天界面本身即交互界面。`setText` 失败时返回的错误信息会经模型转述进对话，出现的时机正是用户真正需要输入中文的那一刻，且此时提示信息最完整、最切题。

因此不新增端点、不改动 Web UI。代价是提示为被动触发——用户尝试输入中文失败后才得知，而非打开页面即得知。取舍成立的理由：用户并非每次使用都需要输入中文，常驻横幅在多数时候是恒定噪音。

### 设备端操作交给 Bash 脚本，状态存文件

安装、启用、切换输入法都是一次性的设备运维操作，不属于 Agent 的运行时职责。用 Bash 脚本实现比经 BFF 端点转发更直接，也便于用户自行查看与修改。

原输入法 id 存入 `.ime-previous` 文件。相比浏览器 localStorage：不受浏览器影响、BFF 重启不丢、换机器仍在。

`examples/browser-extension-bff/deploy/` 下已有 `start.sh`、`pack.sh` 的先例，风格一致。

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

### APK 由用户自行获取

ADBKeyBoard 使用 GPL-2.0 许可，发布资产为 `keyboardservice-debug.apk`（debug 签名，用于测试设备无妨）。

内置到仓库会使 agent-kit 成为 GPL-2.0 二进制的分发者，需自行承担随附源码等合规义务。运行时下载则引入网络依赖与哈希维护负担（上游发新版即失配）。

改由用户手动下载一次，通过环境变量或脚本参数指定路径。agent-kit 既不分发 GPL 二进制也不联网。

## 组件设计

### AdbClient 新增三个方法

```
getDefaultIme(): Promise<string>
  settings get secure default_input_method，返回值已 trim

clearTextViaIme(): Promise<void>
  am broadcast -a ADB_CLEAR_TEXT

inputTextViaIme(text: string): Promise<void>
  文本 base64 编码后 am broadcast -a ADB_INPUT_B64 --es msg <base64>
```

`ime enable` / `ime set` 不进 `AdbClient`——它们只被脚本使用，BFF 运行时不需要修改设备输入法。

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
        返回 ok:false，message 指向 setup 脚本
```

降级路径的清空次数取自快照中已有的 `node.text` 长度，无需额外查询设备。

非 ASCII 且输入法未激活时的错误消息须可直接执行，且说明这是一次性设置：

```
设备未启用 ADBKeyBoard 输入法，无法输入中文。请执行一次性设置：
  pnpm --filter flutter-dev-bff ime:setup
完成后重试即可。ASCII 文本不受影响。
```

### Bash 脚本

`examples/flutter-dev-bff/scripts/ime-setup.sh`：

1. 解析 APK 路径：环境变量 `ADBKEYBOARD_APK_PATH`，否则取第一个位置参数；两者都无则打印用法并退出。
2. 读取当前 `default_input_method`，写入 `.ime-previous`（已是 ADBKeyBoard 时不覆盖该文件，避免把还原目标写成自己）。
3. `adb install -r <apk>`。
4. `adb shell ime enable com.android.adbkeyboard/.AdbIME`——安装后输入法可能需短暂时间才出现在系统列表，失败时等待 1 秒重试一次。
5. `adb shell ime set com.android.adbkeyboard/.AdbIME`。
6. 打印结果与原输入法 id。

`examples/flutter-dev-bff/scripts/ime-restore.sh`：

读取 `.ime-previous`，`adb shell ime set <id>`。文件不存在时打印提示并退出，不猜测还原目标。

两个脚本挂为 package.json 的 `ime:setup` 与 `ime:restore`。均接受可选的设备序列号作为参数透传给 `adb -s`；未提供时依赖 adb 默认选择，多设备场景由 adb 自身报错。

`.ime-previous` 加入 `.gitignore`。

### 文案修正

- [prompts.ts:21](../../../examples/flutter-dev-bff/src/prompts.ts:21) 关于「依赖 Companion App」的说明改为 ADBKeyBoard 与 setup 脚本。
- [flutter-tools.ts:183](../../../examples/flutter-dev-bff/src/flutter-tools.ts:183) 的描述改为如实表述：中文输入需设备已启用 ADBKeyBoard，失败时错误信息含设置指引。

## 测试策略

沿用 `uiautomator-provider.test.ts` 中手写 mock 对象的模式，新增方法补入 mock。

- 输入法已激活 + 中文 → 调用 `clearTextViaIme` 与 `inputTextViaIme`，**未调用** `inputText`
- 输入法已激活 + ASCII → 同样走 base64 路径
- 未激活 + ASCII → 走 `KEYCODE_MOVE_END` + `KEYCODE_DEL`×N + `inputText`
- 未激活 + 中文 → 返回 `ok:false`，message 含 `ime:setup`
- 清空调用发生在输入调用之前（顺序断言）
- 中文文本的 base64 编码结果正确
- `default_input_method` 返回空字符串或 `null` 时不抛异常，按未激活处理
- ref 失效、节点非 editable → 各自的错误

Bash 脚本不写自动化测试：它们是一次性设备运维操作，依赖真实设备，且失败时输出直接可读。

现有 171 个测试须保持通过。

## 范围之外

- 新增 HTTP 端点或改动 Web UI。
- 内置 APK 或运行时下载。
- Phase 4 Companion App。
- `mobile_set_text` 之外的工具。
