import type { AdbClient } from './adb-client.js'
import type { SnapshotProvider } from './device-provider.js'
import type { DeviceNode, DeviceSnapshot } from '../types.js'

interface RawNode {
  text?: string
  resourceId?: string
  className?: string
  contentDescription?: string
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

export class UiAutomatorDumpProvider implements SnapshotProvider {
  private currentNodes = new Map<number, DeviceNode>()

  constructor(private readonly adb: AdbClient) {}

  async snapshot(): Promise<DeviceSnapshot> {
    const xml = await this.adb.dumpUiHierarchy()
    const rawNodes = parseHierarchyXml(xml)

    let packageName = ''
    let screenWidth = 0
    let screenHeight = 0
    const interesting = rawNodes.filter(isInteresting)

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
        ...(raw.className ? { className: raw.className } : {}),
        ...(raw.resourceId ? { resourceId: raw.resourceId } : {}),
        ...(raw.checkable ? { checked: raw.checked } : {}),
        ...(raw.selected ? { selected: raw.selected } : {}),
      }
      nodes.push(node)
      this.currentNodes.set(ref, node)
      ref += 1
    }

    return {
      snapshotId: `snap-${Date.now()}`,
      packageName,
      screenWidth,
      screenHeight,
      nodes,
      ...(nodes.length < interesting.length
        ? { truncated: interesting.length - nodes.length }
        : {}),
    }
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
    await this.adb.shell('input', ['keyevent', 'KEYCODE_MOVE_END'])
    const isAscii = /^[\x20-\x7E]*$/.test(text)
    if (!isAscii) {
      return {
        ok: false,
        message: 'uiautomator 模式仅支持 ASCII 文本输入。非 ASCII（如中文）需要 Companion App 支持。',
      }
    }
    await this.adb.inputText(text)
    return { ok: true, message: `已输入文本（${text.length} 字符）` }
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
