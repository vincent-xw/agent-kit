import type { DeviceNode } from '../../types.js'

export interface DomElement {
  text?: string
  id?: string
  ariaLabel?: string
  placeholder?: string
  tag: string
  rect: { x: number; y: number; width: number; height: number }
  clickable: boolean
  editable: boolean
  scrollable: boolean
  enabled: boolean
}

export function domToNodes(
  elements: DomElement[],
  options: { devicePixelRatio: number },
): { nodes: DeviceNode[] } {
  const dpr = options.devicePixelRatio
  const nodes: DeviceNode[] = elements.map((e, i) => {
    const node: DeviceNode = {
      ref: i + 1,
      nodeId: `web:${i + 1}`,
      bounds: {
        left: Math.round(e.rect.x * dpr),
        top: Math.round(e.rect.y * dpr),
        right: Math.round((e.rect.x + e.rect.width) * dpr),
        bottom: Math.round((e.rect.y + e.rect.height) * dpr),
      },
      clickable: e.clickable,
      scrollable: e.scrollable,
      editable: e.editable,
      enabled: e.enabled,
      focused: false,
      className: e.tag,
    }
    if (e.text) node.text = e.text
    if (e.id) node.resourceId = e.id
    if (e.ariaLabel) node.contentDescription = e.ariaLabel
    // placeholder 作为 hint，帮助 Agent 识别空输入框的用途
    if (e.placeholder) node.hint = e.placeholder
    else if (e.ariaLabel) node.hint = e.ariaLabel
    return node
  })
  return { nodes }
}
