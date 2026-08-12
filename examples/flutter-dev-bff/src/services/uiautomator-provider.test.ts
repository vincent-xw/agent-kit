import { describe, expect, it, vi } from 'vitest'
import { UiAutomatorDumpProvider } from './uiautomator-provider.js'
import type { AdbClient } from './adb-client.js'

const SAMPLE_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="Hello" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][400,280]"/>
    <node index="1" text="" resource-id="com.example:id/button" class="android.widget.Button" package="com.example.app" content-desc="Submit" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,400][300,500]"/>
    <node index="2" text="" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[100,600][800,700]"/>
    <node index="3" text="" resource-id="com.example:id/list" class="android.widget.RecyclerView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,800][1080,1920]"/>
    <node index="4" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1,1]"/>
  </node>
</hierarchy>`

function mockAdb(): AdbClient {
  return {
    dumpUiHierarchy: vi.fn(async () => SAMPLE_XML),
    tap: vi.fn(async () => {}),
    swipe: vi.fn(async () => {}),
    inputText: vi.fn(async () => {}),
    shell: vi.fn(async () => ''),
    listDevices: vi.fn(async () => []),
    getDefaultSerial: vi.fn(async () => 'test'),
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    pressKey: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    forward: vi.fn(async () => {}),
    removeForward: vi.fn(async () => {}),
    logcatTail: vi.fn(async () => ''),
  } as unknown as AdbClient
}

describe('UiAutomatorDumpProvider', () => {
  it('解析 XML 并过滤出有意义的节点', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    const snap = await provider.snapshot()

    expect(snap.packageName).toBe('com.example.app')
    // TextView(text), Button(clickable), EditText(editable), RecyclerView(scrollable)
    // 不包含纯 View（1x1 像素，无文本，不可交互）
    expect(snap.nodes).toHaveLength(4)
  })

  it('分配顺序 ref 编号', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    const snap = await provider.snapshot()

    expect(snap.nodes[0]?.ref).toBe(1)
    expect(snap.nodes[1]?.ref).toBe(2)
    expect(snap.nodes.map((n) => n.ref)).toEqual([1, 2, 3, 4])
  })

  it('正确解析节点属性', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    const snap = await provider.snapshot()

    const title = snap.nodes.find((n) => n.text === 'Hello')
    expect(title).toBeDefined()
    expect(title!.bounds).toEqual({ left: 100, top: 200, right: 400, bottom: 280 })
    expect(title!.resourceId).toBe('com.example:id/title')

    const button = snap.nodes.find((n) => n.contentDescription === 'Submit')
    expect(button!.clickable).toBe(true)
    expect(button!.className).toContain('Button')

    const input = snap.nodes.find((n) => n.editable)
    expect(input!.className).toContain('EditText')

    const list = snap.nodes.find((n) => n.scrollable)
    expect(list!.className).toContain('RecyclerView')
  })

  it('tapNode 通过 ref 查找节点并点击中心坐标', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    await provider.snapshot()
    // ref=2 是 Button，bounds=[100,400][300,500]，中心 (200, 450)
    const result = await provider.tapNode(2)
    expect(result.ok).toBe(true)
    expect(adb.tap).toHaveBeenCalledWith(200, 450)
  })

  it('过期 ref 返回错误', async () => {
    const adb = mockAdb()
    const provider = new UiAutomatorDumpProvider(adb)
    const result = await provider.tapNode(999)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('过期')
  })
})
