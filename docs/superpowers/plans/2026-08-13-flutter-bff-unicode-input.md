# Flutter Dev BFF 中文/Unicode 输入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `mobile_set_text` 兑现它已声明的契约——替换而非追加、支持中文等非 ASCII 字符。

**Architecture:** 接入 ADBKeyBoard 输入法的 `ADB_INPUT_B64` 广播通道。`setText` 按「当前激活输入法」分三条路径：ADBKeyBoard 可用时走 base64 广播，否则 ASCII 走原 `input text`、非 ASCII 返回可执行的设置指引。设备端的安装与切换由 Bash 脚本完成，不新增 HTTP 端点、不改动 Web UI。

**Tech Stack:** TypeScript (ESM)、vitest 3.2.4、Bash、adb

## Global Constraints

- 只修改 `examples/flutter-dev-bff`。不得改动 `packages/` 下任何基础模块，不得改动 `examples/browser-extension-bff`。
- 不新增 HTTP 端点，不改动 `public/index.html`。
- ADBKeyBoard 输入法 id 固定为 `com.android.adbkeyboard/.AdbIME`。
- 探测用 `adb shell settings get secure default_input_method`，**不得**用 `ime list -s`——后者列的是已启用而非当前激活，会产生假阳性。
- 不缓存输入法探测结果。
- 输入法可用时 ASCII 也走 base64 路径。
- 不内置 APK、不联网下载。APK 由用户自行从 https://github.com/senzhk/ADBKeyBoard/releases 下载（GPL-2.0，资产名 `keyboardservice-debug.apk`）。
- 起点：171 个测试通过。每个任务结束时 `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。
- 本仓库 tsconfig 开启 `noUncheckedIndexedAccess`：数组下标与 Map.get 的结果是 `T | undefined`，测试中需用 `!` 断言。

---

## File Structure

- `examples/flutter-dev-bff/scripts/ime-setup.sh` — 新建。一次性安装并启用 ADBKeyBoard，切换前把原输入法写入 `.ime-previous`。
- `examples/flutter-dev-bff/scripts/ime-restore.sh` — 新建。读 `.ime-previous` 还原原输入法。
- `examples/flutter-dev-bff/package.json` — 新增 `ime:setup` 与 `ime:restore` 两个 script。
- `.gitignore`（仓库根） — 新增 `.ime-previous`。
- `examples/flutter-dev-bff/src/services/adb-client.ts` — 新增 `getDefaultIme`、`clearTextViaIme`、`inputTextViaIme` 三个方法。`ime enable` / `ime set` 不进此文件，它们只被脚本使用。
- `examples/flutter-dev-bff/src/services/adb-client.test.ts` — 新建。用 `vi.spyOn` 监视 `shell` 断言 argv 与 base64 编码。
- `examples/flutter-dev-bff/src/services/uiautomator-provider.ts` — 重写 `setText`（当前 `:154-171`）。
- `examples/flutter-dev-bff/src/services/uiautomator-provider.test.ts` — 扩展 mock，新增 setText 测试。
- `examples/flutter-dev-bff/src/prompts.ts:21` — 修正关于中文输入依赖的说明。
- `examples/flutter-dev-bff/src/flutter-tools.ts:183` — 修正 `mobile_set_text` 的描述。

---

### Task 1: Bash 脚本与 npm script

**Files:**
- Create: `examples/flutter-dev-bff/scripts/ime-setup.sh`
- Create: `examples/flutter-dev-bff/scripts/ime-restore.sh`
- Modify: `examples/flutter-dev-bff/package.json`（scripts 段）
- Modify: `.gitignore`（仓库根）

**Interfaces:**
- Consumes: 无。
- Produces: 命令 `pnpm --filter flutter-dev-bff ime:setup` 与 `ime:restore`。Task 3 的错误消息会引用前者的完整命令字符串，须逐字一致。状态文件 `examples/flutter-dev-bff/.ime-previous` 存放切换前的输入法 id。

本任务不写自动化测试——脚本依赖真实设备、属一次性运维操作，失败输出直接可读。验证方式是语法检查加无设备时的错误路径。

- [ ] **Step 1: 创建 ime-setup.sh**

```bash
#!/usr/bin/env bash
# ADBKeyBoard 一次性安装与启用脚本（用于中文/Unicode 文本输入）
# 用法：./ime-setup.sh <APK 路径> [设备序列号]
#   APK 路径也可用环境变量 ADBKEYBOARD_APK_PATH 指定
# APK 下载：https://github.com/senzhk/ADBKeyBoard/releases （GPL-2.0）

set -e

IME_ID="com.android.adbkeyboard/.AdbIME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BFF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREV_FILE="$BFF_ROOT/.ime-previous"

echo_ok()   { echo -e "  \033[32m[OK]\033[0m $1"; }
echo_warn() { echo -e "  \033[33m[!!]\033[0m $1"; }
echo_err()  { echo -e "  \033[31m[XX]\033[0m $1"; }

APK="${1:-$ADBKEYBOARD_APK_PATH}"
SERIAL="$2"
ADB=(adb)
if [ -n "$SERIAL" ]; then ADB=(adb -s "$SERIAL"); fi

if [ -z "$APK" ]; then
    echo_err "未指定 APK 路径。"
    echo "用法：$0 <APK 路径> [设备序列号]"
    echo "或：export ADBKEYBOARD_APK_PATH=/path/to/keyboardservice-debug.apk"
    echo "下载：https://github.com/senzhk/ADBKeyBoard/releases"
    exit 1
fi

if [ ! -f "$APK" ]; then
    echo_err "APK 文件不存在：$APK"
    exit 1
fi

CURRENT="$("${ADB[@]}" shell settings get secure default_input_method | tr -d '\r\n')"
echo_ok "当前输入法：${CURRENT:-（未能读取）}"

# 已是 ADBKeyBoard 时不覆盖记录，否则还原目标会变成自己
if [ "$CURRENT" = "$IME_ID" ]; then
    echo_warn "ADBKeyBoard 已是当前输入法，保留原有 .ime-previous"
else
    echo "$CURRENT" > "$PREV_FILE"
    echo_ok "原输入法已记录到 .ime-previous"
fi

"${ADB[@]}" install -r "$APK"
echo_ok "APK 已安装"

# 安装后输入法可能需短暂时间才出现在系统列表
if ! "${ADB[@]}" shell ime enable "$IME_ID"; then
    echo_warn "enable 失败，等待 1 秒后重试"
    sleep 1
    "${ADB[@]}" shell ime enable "$IME_ID"
fi
echo_ok "输入法已启用"

"${ADB[@]}" shell ime set "$IME_ID"
echo_ok "已切换为 ADBKeyBoard，现在可以输入中文"
echo ""
echo "还原原输入法：pnpm --filter flutter-dev-bff ime:restore"
```

- [ ] **Step 2: 创建 ime-restore.sh**

```bash
#!/usr/bin/env bash
# 还原 ime-setup.sh 切换前的输入法
# 用法：./ime-restore.sh [设备序列号]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BFF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREV_FILE="$BFF_ROOT/.ime-previous"

echo_ok()  { echo -e "  \033[32m[OK]\033[0m $1"; }
echo_err() { echo -e "  \033[31m[XX]\033[0m $1"; }

SERIAL="$1"
ADB=(adb)
if [ -n "$SERIAL" ]; then ADB=(adb -s "$SERIAL"); fi

if [ ! -f "$PREV_FILE" ]; then
    echo_err "未找到 $PREV_FILE，无法确定还原目标。"
    echo "请在设备的「设置 → 语言与输入法」中手动切换。"
    exit 1
fi

PREV="$(tr -d '\r\n' < "$PREV_FILE")"
if [ -z "$PREV" ]; then
    echo_err ".ime-previous 内容为空，无法确定还原目标。"
    echo "请在设备的「设置 → 语言与输入法」中手动切换。"
    exit 1
fi

"${ADB[@]}" shell ime set "$PREV"
echo_ok "已还原为：$PREV"
```

- [ ] **Step 3: 赋予可执行权限**

Run:
```bash
chmod +x examples/flutter-dev-bff/scripts/ime-setup.sh examples/flutter-dev-bff/scripts/ime-restore.sh
```

- [ ] **Step 4: 注册 npm script**

在 `examples/flutter-dev-bff/package.json` 的 `scripts` 段中，`"test": "vitest run",` 之后加入两行：

```json
    "ime:setup": "bash scripts/ime-setup.sh",
    "ime:restore": "bash scripts/ime-restore.sh",
```

- [ ] **Step 5: 忽略状态文件**

在仓库根 `.gitignore` 的 `.DS_Store` 之前加入：

```
# ime-setup.sh 记录的切换前输入法，仅本地有意义
.ime-previous
```

- [ ] **Step 6: 语法检查与错误路径验证**

Run: `bash -n examples/flutter-dev-bff/scripts/ime-setup.sh && bash -n examples/flutter-dev-bff/scripts/ime-restore.sh && echo "语法 OK"`
Expected: 输出「语法 OK」，无报错。

Run: `cd examples/flutter-dev-bff && pnpm ime:setup`
Expected: 退出码 1，打印「未指定 APK 路径。」与用法说明（因为没传参数也没设环境变量）。

Run: `cd examples/flutter-dev-bff && pnpm ime:setup /nonexistent/x.apk`
Expected: 退出码 1，打印「APK 文件不存在：/nonexistent/x.apk」。

Run: `cd examples/flutter-dev-bff && pnpm ime:restore`
Expected: 退出码 1，打印未找到 `.ime-previous` 的提示（此时该文件尚不存在）。

Run: `git status --short`
Expected: 不出现 `.ime-previous`（若上面步骤意外创建了它，说明 gitignore 未生效）。

- [ ] **Step 7: 提交**

```bash
git add examples/flutter-dev-bff/scripts/ime-setup.sh examples/flutter-dev-bff/scripts/ime-restore.sh examples/flutter-dev-bff/package.json .gitignore
git commit -m "feat: 新增 ADBKeyBoard 输入法安装与还原脚本

adb shell input text 不支持 Unicode，中文输入需借助 ADBKeyBoard
的广播通道。安装与切换默认输入法是一次性设备运维操作，用脚本比
经 BFF 端点转发更直接。

切换前把原输入法写入 .ime-previous 以便还原；已是 ADBKeyBoard 时
不覆盖该文件，否则还原目标会变成自己。APK 因 GPL-2.0 不内置，由
用户自行下载并指定路径。"
```

---

### Task 2: AdbClient 三个输入法相关方法

**Files:**
- Modify: `examples/flutter-dev-bff/src/services/adb-client.ts`（在 `shell` 方法之前插入）
- Test: `examples/flutter-dev-bff/src/services/adb-client.test.ts`（新建）

**Interfaces:**
- Consumes: 已有的 `shell(command: string, args: string[], deviceSerial?: string): Promise<string>`。
- Produces:
  - `getDefaultIme(deviceSerial?: string): Promise<string>` — 返回已 trim 的输入法 id；设备返回 `null` 或空时返回空字符串。
  - `clearTextViaIme(deviceSerial?: string): Promise<void>`
  - `inputTextViaIme(text: string, deviceSerial?: string): Promise<void>`
  
  Task 3 的 `setText` 调用这三个方法。

- [ ] **Step 1: 写失败的测试**

创建 `src/services/adb-client.test.ts`。`AdbClient` 的方法定义在原型上，`vi.spyOn(client, 'shell')` 会在实例上建立遮蔽属性，方法内部的 `this.shell(...)` 因此解析到 spy，无需 mock `node:child_process`。

```ts
import { describe, expect, it, vi } from 'vitest'
import { AdbClient } from './adb-client.js'

function clientWithSpy() {
  const client = new AdbClient()
  const shell = vi.spyOn(client, 'shell').mockResolvedValue('')
  return { client, shell }
}

describe('AdbClient.getDefaultIme', () => {
  it('读取 default_input_method 并 trim 换行', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('com.android.adbkeyboard/.AdbIME\n')

    const result = await client.getDefaultIme()

    expect(result).toBe('com.android.adbkeyboard/.AdbIME')
    expect(shell).toHaveBeenCalledWith('settings', ['get', 'secure', 'default_input_method'], undefined)
  })

  it('设备返回 null 时视为空', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('null\n')

    expect(await client.getDefaultIme()).toBe('')
  })

  it('设备返回空白时视为空', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('  \n')

    expect(await client.getDefaultIme()).toBe('')
  })

  it('透传设备序列号', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('x\n')

    await client.getDefaultIme('emulator-5554')

    expect(shell).toHaveBeenCalledWith('settings', ['get', 'secure', 'default_input_method'], 'emulator-5554')
  })
})

describe('AdbClient.clearTextViaIme', () => {
  it('发送 ADB_CLEAR_TEXT 广播', async () => {
    const { client, shell } = clientWithSpy()

    await client.clearTextViaIme()

    expect(shell).toHaveBeenCalledWith('am', ['broadcast', '-a', 'ADB_CLEAR_TEXT'], undefined)
  })
})

describe('AdbClient.inputTextViaIme', () => {
  it('中文文本按 UTF-8 base64 编码后广播', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('杭州')

    // '杭州' UTF-8 → base64
    expect(shell).toHaveBeenCalledWith(
      'am',
      ['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', '5p2t5bee'],
      undefined,
    )
  })

  it('ASCII 文本同样走 base64', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('hello')

    expect(shell).toHaveBeenCalledWith(
      'am',
      ['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', 'aGVsbG8='],
      undefined,
    )
  })

  it('base64 结果不含 shell 元字符', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('a;b && c `d` $(e)')

    const encoded = shell.mock.calls[0]![1][5]!
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/adb-client.test.ts`
Expected: FAIL，报 `client.getDefaultIme is not a function`。

- [ ] **Step 3: 实现三个方法**

在 `src/services/adb-client.ts` 的 `shell` 方法之前插入：

```ts
  /** 读取设备当前激活的输入法 id。设备返回 null 或空白时返回空字符串。 */
  async getDefaultIme(deviceSerial?: string): Promise<string> {
    const output = await this.shell('settings', ['get', 'secure', 'default_input_method'], deviceSerial)
    const trimmed = output.trim()
    return trimmed === 'null' ? '' : trimmed
  }

  /** 通过 ADBKeyBoard 清空当前焦点输入框。要求它是当前激活输入法。 */
  async clearTextViaIme(deviceSerial?: string): Promise<void> {
    await this.shell('am', ['broadcast', '-a', 'ADB_CLEAR_TEXT'], deviceSerial)
  }

  /**
   * 通过 ADBKeyBoard 输入任意 Unicode 文本。要求它是当前激活输入法。
   *
   * 用 base64 而非明文广播有两个原因：上游 README 指出明文在 Oreo/P 上有
   * UTF-8 问题；且 base64 字母表不含 shell 元字符，消除了经设备 shell 的注入面。
   */
  async inputTextViaIme(text: string, deviceSerial?: string): Promise<void> {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    await this.shell('am', ['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', encoded], deviceSerial)
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/adb-client.test.ts`
Expected: PASS，8 个测试全过。

- [ ] **Step 5: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功，测试 179 通过（171 + 本任务 8）。

- [ ] **Step 6: 提交**

```bash
git add examples/flutter-dev-bff/src/services/adb-client.ts examples/flutter-dev-bff/src/services/adb-client.test.ts
git commit -m "feat: AdbClient 新增输入法探测与 Unicode 广播输入

getDefaultIme 查 settings get secure default_input_method，而不是
ime list -s——后者列的是已启用而非当前激活，ADBKeyBoard 未激活时
广播不生效，用它判断会产生假阳性。

inputTextViaIme 用 base64 广播：上游指出明文在 Oreo/P 有 UTF-8
问题，且 base64 字母表不含 shell 元字符，顺带消除注入面。"
```

---

### Task 3: setText 重写与文案修正

**Files:**
- Modify: `examples/flutter-dev-bff/src/services/uiautomator-provider.ts`（`setText` 方法，当前 `:154-171`；文件顶部加常量）
- Modify: `examples/flutter-dev-bff/src/prompts.ts:21`
- Modify: `examples/flutter-dev-bff/src/flutter-tools.ts:183`
- Test: `examples/flutter-dev-bff/src/services/uiautomator-provider.test.ts`（扩展 mock 并新增 describe 块）

**Interfaces:**
- Consumes: Task 2 的 `getDefaultIme`、`clearTextViaIme`、`inputTextViaIme`；Task 1 产出的命令字符串 `pnpm --filter flutter-dev-bff ime:setup`。
- Produces: 无下游任务。

现有 `SAMPLE_XML` 中 index 2 的节点 `class="android.widget.EditText"`，经 `editable: className?.includes('EditText')` 判定为可编辑，可直接用作 setText 的目标。快照后它的 ref 需由测试从 `snapshot()` 结果中查出，不要硬编码。

- [ ] **Step 1: 扩展 mock 并写失败的测试**

在 `src/services/uiautomator-provider.test.ts` 的 `mockAdb()` 返回对象中，`shell` 那一行之后加入三个新方法：

```ts
    getDefaultIme: vi.fn(async () => ''),
    clearTextViaIme: vi.fn(async () => {}),
    inputTextViaIme: vi.fn(async () => {}),
```

在文件末尾追加：

```ts
describe('UiAutomatorDumpProvider.setText', () => {
  async function providerWithEditable(adb: AdbClient) {
    const provider = new UiAutomatorDumpProvider(adb)
    const snapshot = await provider.snapshot()
    const editable = snapshot.nodes.find((n) => n.editable)
    return { provider, ref: editable!.ref }
  }

  it('ADBKeyBoard 激活时走 base64 广播，不调用 inputText', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('com.android.adbkeyboard/.AdbIME')
    const { provider, ref } = await providerWithEditable(adb)

    const result = await provider.setText(ref, '杭州')

    expect(result.ok).toBe(true)
    expect(adb.clearTextViaIme).toHaveBeenCalled()
    expect(adb.inputTextViaIme).toHaveBeenCalledWith('杭州')
    expect(adb.inputText).not.toHaveBeenCalled()
  })

  it('ADBKeyBoard 激活时 ASCII 也走 base64', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('com.android.adbkeyboard/.AdbIME')
    const { provider, ref } = await providerWithEditable(adb)

    await provider.setText(ref, 'hangzhou')

    expect(adb.inputTextViaIme).toHaveBeenCalledWith('hangzhou')
    expect(adb.inputText).not.toHaveBeenCalled()
  })

  it('清空发生在输入之前', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('com.android.adbkeyboard/.AdbIME')
    const order: string[] = []
    vi.mocked(adb.clearTextViaIme).mockImplementation(async () => { order.push('clear') })
    vi.mocked(adb.inputTextViaIme).mockImplementation(async () => { order.push('input') })
    const { provider, ref } = await providerWithEditable(adb)

    await provider.setText(ref, '杭州')

    expect(order).toEqual(['clear', 'input'])
  })

  it('未激活且文本为 ASCII 时降级：MOVE_END + DEL + input text', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('com.baidu.input/.ImeService')
    const { provider, ref } = await providerWithEditable(adb)

    const result = await provider.setText(ref, 'hello')

    expect(result.ok).toBe(true)
    expect(adb.inputText).toHaveBeenCalledWith('hello')
    expect(adb.inputTextViaIme).not.toHaveBeenCalled()
    const shellCalls = vi.mocked(adb.shell).mock.calls
    expect(shellCalls.some((c) => c[1]?.includes('KEYCODE_MOVE_END'))).toBe(true)
  })

  it('未激活且含非 ASCII 时返回可执行的设置指引', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('com.baidu.input/.ImeService')
    const { provider, ref } = await providerWithEditable(adb)

    const result = await provider.setText(ref, '杭州')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('pnpm --filter flutter-dev-bff ime:setup')
    expect(adb.inputText).not.toHaveBeenCalled()
    expect(adb.inputTextViaIme).not.toHaveBeenCalled()
  })

  it('探测返回空字符串时按未激活处理，ASCII 仍可输入', async () => {
    const adb = mockAdb()
    vi.mocked(adb.getDefaultIme).mockResolvedValue('')
    const { provider, ref } = await providerWithEditable(adb)

    const result = await provider.setText(ref, 'hello')

    expect(result.ok).toBe(true)
    expect(adb.inputText).toHaveBeenCalledWith('hello')
  })

  it('ref 失效时报错且不碰设备', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)

    const result = await provider.setText(999, 'hello')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('重新 mobile_snapshot')
    expect(adb.tap).not.toHaveBeenCalled()
  })

  it('目标节点不可编辑时报错', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    const snapshot = await provider.snapshot()
    const notEditable = snapshot.nodes.find((n) => !n.editable)

    const result = await provider.setText(notEditable!.ref, 'hello')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不是可编辑输入框')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/uiautomator-provider.test.ts`
Expected: FAIL。中文相关用例因当前实现直接返回「仅支持 ASCII」而失败；base64 相关断言因未调用新方法而失败。

- [ ] **Step 3: 重写 setText**

在 `src/services/uiautomator-provider.ts` 的 import 之后、`parseBool` 之前加入常量：

```ts
/** ADBKeyBoard 输入法 id。它必须是当前激活输入法，广播才会生效。 */
const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'

/** 降级路径逐字符删除的上限，避免超长文本产生过长命令行。 */
const MAX_DELETE_KEYS = 500
```

把 `setText` 整个方法替换为：

```ts
  async setText(ref: number, text: string): Promise<{ ok: boolean; message: string }> {
    const node = this.currentNodes.get(ref)
    if (!node) return { ok: false, message: '节点引用已过期，请重新 mobile_snapshot' }
    if (!node.editable) return { ok: false, message: '目标节点不是可编辑输入框' }
    const x = Math.round((node.bounds.left + node.bounds.right) / 2)
    const y = Math.round((node.bounds.top + node.bounds.bottom) / 2)
    await this.adb.tap(x, y)

    // 不缓存探测结果：用户可能在 BFF 运行期间才装好输入法。
    const activeIme = await this.adb.getDefaultIme()
    if (activeIme === ADB_KEYBOARD_IME) {
      await this.adb.clearTextViaIme()
      await this.adb.inputTextViaIme(text)
      return { ok: true, message: `已设置文本（${text.length} 字符）` }
    }

    if (!/^[\x20-\x7E]*$/.test(text)) {
      return {
        ok: false,
        message:
          '设备未启用 ADBKeyBoard 输入法，无法输入非 ASCII 文本。请执行一次性设置：\n' +
          '  pnpm --filter flutter-dev-bff ime:setup <APK 路径>\n' +
          'APK 下载：https://github.com/senzhk/ADBKeyBoard/releases\n' +
          '完成后重试即可。ASCII 文本不受影响。',
      }
    }

    // 降级路径：清空后再输入，使行为与「设置文本」的契约一致。
    // 删除次数取自快照已有的 node.text，无需额外查询设备。
    await this.adb.shell('input', ['keyevent', 'KEYCODE_MOVE_END'])
    const existingLength = Math.min(node.text?.length ?? 0, MAX_DELETE_KEYS)
    if (existingLength > 0) {
      await this.adb.shell('input', [
        'keyevent',
        ...Array.from({ length: existingLength }, () => 'KEYCODE_DEL'),
      ])
    }
    await this.adb.inputText(text)
    return { ok: true, message: `已设置文本（${text.length} 字符）` }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd examples/flutter-dev-bff && pnpm vitest run src/services/uiautomator-provider.test.ts`
Expected: PASS，13 个测试全过（原 5 个 + 本任务 8 个）。

- [ ] **Step 5: 修正 prompts.ts 的说明**

把 `src/prompts.ts` 第 21 行整行：

```
  '- 中文等非 ASCII 文本输入依赖设备 Companion App。如果 set_text 提示不支持，说明当前使用的是 uiautomator 降级模式。',
```

替换为：

```
  '- 中文等非 ASCII 文本输入需要设备启用 ADBKeyBoard 输入法。如果 mobile_set_text 报未启用，把它的错误信息原样告诉用户，其中包含一次性设置命令。ASCII 文本无需该输入法。',
```

- [ ] **Step 6: 修正工具描述**

把 `src/flutter-tools.ts` 第 183 行的 description 整行：

```ts
      description: '向可编辑节点设置文本（替换原有内容）。优先使用此工具输入文本，它支持中文等非 ASCII 字符。',
```

替换为：

```ts
      description: '向可编辑节点设置文本，会先清空原有内容再输入。优先使用此工具而非坐标操作。中文等非 ASCII 文本需要设备已启用 ADBKeyBoard 输入法；未启用时本工具会返回包含设置命令的错误信息，ASCII 文本不受影响。',
```

- [ ] **Step 7: 跑全量校验**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: 三条命令均成功，测试 187 通过（179 + 本任务 8）。`examples/browser-extension-bff` 的 26 个测试通过，是未影响插件路径的证据（见 [AGENTS.md](../../../AGENTS.md)）。

- [ ] **Step 8: 提交**

```bash
git add examples/flutter-dev-bff/src/services/uiautomator-provider.ts examples/flutter-dev-bff/src/services/uiautomator-provider.test.ts examples/flutter-dev-bff/src/prompts.ts examples/flutter-dev-bff/src/flutter-tools.ts
git commit -m "fix: mobile_set_text 兑现契约——清空后输入，支持中文

工具描述原本声明「替换原有内容」且「支持中文」，两项都没做到：
先 MOVE_END 再输入导致追加；非 ASCII 直接硬失败。prompts 里关于
依赖 Companion App 的说明还与工具描述自相矛盾。

现按当前激活输入法分三条路径：ADBKeyBoard 可用时走 base64 广播
（ASCII 也走此路，行为统一且无注入面）；未启用时 ASCII 走原路径
但先清空；未启用且含非 ASCII 则返回带一次性设置命令的错误。"
```

---

## 收尾说明

真机验证时的一次性设置步骤：

```bash
# 1. 从 https://github.com/senzhk/ADBKeyBoard/releases 下载 keyboardservice-debug.apk
# 2. 安装并启用
pnpm --filter flutter-dev-bff ime:setup ~/Downloads/keyboardservice-debug.apk
# 3. 测试结束后还原原输入法
pnpm --filter flutter-dev-bff ime:restore
```

`FLUTTER_DEV_BFF.md` 中提到「非 ASCII 需要 Companion App」的表述在本计划完成后不再准确，但该文件的整体更新不在本计划范围内。

Phase 4 Companion App 落地后，无障碍服务的 `ACTION_SET_TEXT` 原生支持 Unicode，届时本计划引入的 ADBKeyBoard 依赖可移除——`SnapshotProvider` 是可替换接口，`setText` 的实现会随 provider 一起被替代。
