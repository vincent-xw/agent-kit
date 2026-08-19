import type { AdbClient } from './adb-client.js'
import type { SnapshotProvider } from './device-provider.js'
import type { DeviceNode, DeviceSnapshot } from '../types.js'

interface RawNode {
  text?: string
  resourceId?: string
  className?: string
  contentDescription?: string
  hint?: string
  packageName?: string
  clickable: boolean
  scrollable: boolean
  editable: boolean
  checkable: boolean
  checked: boolean
  enabled: boolean
  focused: boolean
  selected: boolean
  bounds: { left: number; top: number; right: number; bottom: number }
}

/** ADBKeyBoard 输入法 id。它必须是当前激活输入法，广播才会生效。 */
const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'

/** 降级路径逐字符删除的上限，避免超长文本产生过长命令行。 */
const MAX_DELETE_KEYS = 500

function parseBool(value: string | undefined): boolean {
  return value === 'true'
}

function parseBounds(bounds: string | undefined): RawNode['bounds'] | null {
  if (!bounds) return null
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (!match) return null
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  }
}

function parseNodeAttributes(tagText: string): RawNode | null {
  const attrs: Record<string, string> = {}
  const attrRegex = /(\w[\w-]*)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = attrRegex.exec(tagText)) !== null) {
    const key = m[1]
    if (key) attrs[key] = m[2] ?? ''
  }
  const bounds = parseBounds(attrs.bounds)
  if (!bounds) return null
  const className = attrs.class
  return {
    ...(attrs.text ? { text: attrs.text } : {}),
    ...(attrs['resource-id'] ? { resourceId: attrs['resource-id'] } : {}),
    ...(className ? { className } : {}),
    ...(attrs['content-desc'] ? { contentDescription: attrs['content-desc'] } : {}),
    ...(attrs.hint ? { hint: attrs.hint } : {}),
    ...(attrs.package ? { packageName: attrs.package } : {}),
    clickable: parseBool(attrs.clickable),
    scrollable: parseBool(attrs.scrollable),
    editable: className?.includes('EditText') ?? false,
    checkable: parseBool(attrs.checkable),
    checked: parseBool(attrs.checked),
    enabled: parseBool(attrs.enabled),
    focused: parseBool(attrs.focused),
    selected: parseBool(attrs.selected),
    bounds,
  }
}

function parseHierarchyXml(xml: string): RawNode[] {
  const nodes: RawNode[] = []
  const nodeTagRegex = /<node\b([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = nodeTagRegex.exec(xml)) !== null) {
    const attrs = m[1]
    if (!attrs) continue
    const node = parseNodeAttributes(attrs)
    if (node) nodes.push(node)
  }
  return nodes
}

function isInteresting(node: RawNode): boolean {
  if (node.clickable || node.scrollable || node.editable || node.checkable) return true
  if (node.text && node.text.trim().length > 0) return true
  if (node.contentDescription && node.contentDescription.trim().length > 0) return true
  return false
}

const MAX_NODES = 200

/** 操作后等待 UI 稳定的基础时间（毫秒）。 */
const STABLE_WAIT_MS = 500
/** snapshot 检测到包名变化时的重试等待（毫秒）。 */
const RETRY_WAIT_MS = 1500

/** 简单 sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class UiAutomatorDumpProvider implements SnapshotProvider {
  private currentNodes = new Map<number, DeviceNode>()
  private lastPackageName = ''
  private lastSnapshotAt = 0

  constructor(private readonly adb: AdbClient) {}

  async snapshot(): Promise<DeviceSnapshot> {
    // 首次调用不等待；后续调用距离上次操作不到 STABLE_WAIT_MS 时，补一个短等待，
    // 让点击/按键后的页面切换动画和无障碍树更新完成。
    const sinceLast = Date.now() - this.lastSnapshotAt
    if (this.lastSnapshotAt > 0 && sinceLast < STABLE_WAIT_MS) {
      await sleep(STABLE_WAIT_MS - sinceLast)
    }

    let xml = await this.adb.dumpUiHierarchy()
    let rawNodes = parseHierarchyXml(xml)
    let packageName = rawNodes.find((n) => n.packageName)?.packageName ?? ''

    // 如果包名和上次不同（说明刚发生页面跳转），再等一会儿重试一次，
    // 避免抓到跳转过程中的中间帧。
    if (this.lastPackageName && packageName && packageName !== this.lastPackageName) {
      await sleep(RETRY_WAIT_MS)
      xml = await this.adb.dumpUiHierarchy()
      rawNodes = parseHierarchyXml(xml)
      const secondPkg = rawNodes.find((n) => n.packageName)?.packageName ?? ''
      if (secondPkg) packageName = secondPkg
    }
    const interesting = rawNodes.filter(isInteresting)

    let screenWidth = 0
    let screenHeight = 0
    this.currentNodes.clear()
    const nodes: DeviceNode[] = []
    let ref = 1
    for (const raw of interesting) {
      if (ref > MAX_NODES) break
      if (!packageName && raw.packageName) packageName = raw.packageName
      const { right, bottom } = raw.bounds
      if (right > screenWidth) screenWidth = right
      if (bottom > screenHeight) screenHeight = bottom
      const node: DeviceNode = {
        ref,
        nodeId: String(ref),
        bounds: raw.bounds,
        clickable: raw.clickable,
        scrollable: raw.scrollable,
        editable: raw.editable,
        enabled: raw.enabled,
        focused: raw.focused,
        ...(raw.text ? { text: raw.text } : {}),
        ...(raw.contentDescription ? { contentDescription: raw.contentDescription } : {}),
        ...(raw.hint ? { hint: raw.hint } : {}),
        ...(raw.className ? { className: raw.className } : {}),
        ...(raw.resourceId ? { resourceId: raw.resourceId } : {}),
        ...(raw.checkable ? { checked: raw.checked } : {}),
        ...(raw.selected ? { selected: raw.selected } : {}),
      }
      nodes.push(node)
      this.currentNodes.set(ref, node)
      ref += 1
    }

    const result: DeviceSnapshot = {
      snapshotId: `snap-${Date.now()}`,
      packageName,
      screenWidth,
      screenHeight,
      nodes,
      ...(nodes.length < interesting.length
        ? { truncated: interesting.length - nodes.length }
        : {}),
    }
    this.trackSnapshot(packageName)
    return result
  }

  // 记录最后一次 snapshot 的包名和时间，供下次 snapshot 判断页面是否切换
  private trackSnapshot(packageName: string): void {
    this.lastPackageName = packageName
    this.lastSnapshotAt = Date.now()
  }

  async tapNode(ref: number): Promise<{ ok: boolean; message: string }> {
    const node = this.currentNodes.get(ref)
    if (!node) return { ok: false, message: '节点引用已过期，请重新 mobile_snapshot' }
    const x = Math.round((node.bounds.left + node.bounds.right) / 2)
    const y = Math.round((node.bounds.top + node.bounds.bottom) / 2)
    await this.adb.tap(x, y)
    return { ok: true, message: `已点击 (${x}, ${y})` }
  }

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

  async scrollNode(
    ref: number,
    direction: 'forward' | 'backward',
  ): Promise<{ ok: boolean; message: string }> {
    const node = this.currentNodes.get(ref)
    if (!node) return { ok: false, message: '节点引用已过期，请重新 mobile_snapshot' }
    const { left, top, right, bottom } = node.bounds
    const cx = Math.round((left + right) / 2)
    const cy = Math.round((top + bottom) / 2)
    const distance = Math.round((bottom - top) * 0.6)
    if (direction === 'forward') {
      await this.adb.swipe(cx, cy, cx, cy - distance, 300)
    } else {
      await this.adb.swipe(cx, cy, cx, cy + distance, 300)
    }
    return { ok: true, message: `已${direction === 'forward' ? '向下' : '向上'}滚动` }
  }
}
