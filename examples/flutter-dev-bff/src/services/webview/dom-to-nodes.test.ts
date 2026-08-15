import { describe, expect, it } from 'vitest'
import { domToNodes } from './dom-to-nodes.js'
import type { DomElement } from './dom-to-nodes.js'

function el(partial: Partial<DomElement>): DomElement {
  return {
    tag: 'div',
    rect: { x: 0, y: 0, width: 100, height: 40 },
    clickable: false,
    editable: false,
    scrollable: false,
    enabled: true,
    ...partial,
  }
}

describe('domToNodes', () => {
  it('把 DOM 元素转成带连续 ref 的节点', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'button', text: '登录', clickable: true })],
      { devicePixelRatio: 2 },
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.ref).toBe(1)
    expect(nodes[0]!.className).toBe('button')
    expect(nodes[0]!.text).toBe('登录')
    expect(nodes[0]!.clickable).toBe(true)
  })

  it('id 映射为 resourceId，aria-label 映射为 contentDescription', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'input', id: 'username', ariaLabel: '用户名', editable: true })],
      { devicePixelRatio: 1 },
    )
    expect(nodes[0]!.resourceId).toBe('username')
    expect(nodes[0]!.contentDescription).toBe('用户名')
    expect(nodes[0]!.editable).toBe(true)
  })

  it('bounds 按 devicePixelRatio 放大到设备像素', () => {
    const { nodes } = domToNodes(
      [el({ rect: { x: 5, y: 10, width: 50, height: 20 } })],
      { devicePixelRatio: 3 },
    )
    expect(nodes[0]!.bounds).toEqual({ left: 15, top: 30, right: 165, bottom: 90 })
  })

  it('空文本/无 id 时省略可选字段', () => {
    const { nodes } = domToNodes([el({})], { devicePixelRatio: 1 })
    expect(nodes[0]!.text).toBeUndefined()
    expect(nodes[0]!.resourceId).toBeUndefined()
  })

  it('disabled 元素标记 enabled=false', () => {
    const { nodes } = domToNodes(
      [el({ tag: 'button', clickable: true, enabled: false })],
      { devicePixelRatio: 1 },
    )
    expect(nodes[0]!.enabled).toBe(false)
  })
})
