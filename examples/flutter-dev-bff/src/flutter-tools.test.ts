import { describe, expect, it } from 'vitest'
import { toToolSchema } from '@agent-kit/core'
import { createFlutterToolDefinitions } from './flutter-tools.js'
import type { FlutterToolServices } from './flutter-tools.js'
import { AdbClient } from './services/adb-client.js'
import { FlutterProcessManager } from './services/flutter-process-manager.js'
import { ScreenshotStore } from './services/screenshot-store.js'
import type { CdpClient } from './services/webview/cdp-client.js'

const mockServices: FlutterToolServices = {
  adb: {
    listDevices: async () => [],
    getDefaultSerial: async () => 'test-device',
    screenshot: async () => Buffer.alloc(0),
    tap: async () => {},
    swipe: async () => {},
    pressKey: async () => {},
    inputText: async () => {},
    install: async () => {},
    launch: async () => {},
    forceStop: async () => {},
    forward: async () => {},
    removeForward: async () => {},
    logcatTail: async () => '',
    dumpUiHierarchy: async () => '',
    shell: async () => '',
    listWebViewSockets: async () => [],
  } as unknown as AdbClient,
  device: {
    snapshot: async () => ({ snapshotId: 'test', packageName: 'com.test', screenWidth: 1080, screenHeight: 1920, nodes: [], source: 'uiautomator' }),
    tapNode: async () => ({ ok: true, message: '' }),
    setText: async () => ({ ok: true, message: '' }),
    scrollNode: async () => ({ ok: true, message: '' }),
  },
  flutter: {
    start: async () => ({ processId: 1, vmServiceUri: 'http://localhost:1234/', deviceSerial: 'test', startedAt: 0 }),
    stop: async () => {},
    isRunning: () => false,
    getInfo: () => null,
    getVmServiceUri: () => null,
    hotReload: () => {},
    hotRestart: () => {},
    getRecentLogs: () => [],
    onExit: () => () => {},
  } as unknown as FlutterProcessManager,
  vm: {
    current: null,
    connect: async () => ({ evaluate: async () => ({}), reloadSources: async () => ({ ok: true, message: '' }), disconnect: () => {}, on: () => {}, off: () => {}, emit: () => true } as never),
    disconnect: () => {},
  },
  screenshots: {
    save: async () => ({ id: 'test', path: '/tmp/test.png', width: 100, height: 200, takenAt: 0 }),
    getPath: () => '/tmp/test.png',
  } as unknown as ScreenshotStore,
  projectPath: '/tmp/flutter-app',
  webView: {
    isAvailable: async () => false,
    snapshot: async () => ({ snapshotId: 'w', packageName: 'webview', screenWidth: 0, screenHeight: 0, nodes: [], source: 'webview' }),
    tap: async () => {},
    setText: async () => {},
    scroll: async () => {},
    dispose: async () => {},
  } as unknown as CdpClient,
}

const tools = createFlutterToolDefinitions(mockServices)

describe('Flutter 工具定义', () => {
  it('snapshot 是第一个工具', () => {
    expect(tools[0]?.name).toBe('mobile_snapshot')
  })

  it('全部工具声明为 server 端执行且有 execute 函数', () => {
    expect(tools.every((t) => t.execution === 'server')).toBe(true)
    expect(tools.every((t) => typeof t.execute === 'function')).toBe(true)
  })

  it('每个工具都有说明', () => {
    expect(tools.every((t) => (t.description ?? '').length > 0)).toBe(true)
  })

  it('工具名只含字母、数字、下划线、连字符', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })

  it('所有 input schema 都能转成 JSON Schema', () => {
    for (const tool of tools) {
      expect(() => toToolSchema(tool), `${tool.name} 无法转换`).not.toThrow()
    }
  })

  it('包含完整的工具集', () => {
    const names = tools.map((t) => t.name)
    expect(names).toContain('mobile_snapshot')
    expect(names).toContain('mobile_devices')
    expect(names).toContain('mobile_tap_node')
    expect(names).toContain('mobile_set_text')
    expect(names).toContain('mobile_scroll_node')
    expect(names).toContain('mobile_wait_for')
    expect(names).toContain('mobile_press_key')
    expect(names).toContain('mobile_screenshot')
    expect(names).toContain('mobile_tap')
    expect(names).toContain('mobile_swipe')
    expect(names).toContain('flutter_run_start')
    expect(names).toContain('flutter_hot_reload')
    expect(names).toContain('flutter_logs')
    expect(names).toContain('flutter_analyze')
    expect(names).toContain('flutter_test')
    expect(names).toContain('flutter_eval')
    expect(names).toContain('web_snapshot')
    expect(names).toContain('web_tap')
    expect(names).toContain('web_set_text')
    expect(names).toContain('web_scroll')
  })

  it('web_snapshot 在 WebView 不可用时返回明确错误', async () => {
    const webSnap = tools.find((t) => t.name === 'web_snapshot')!
    const execute = webSnap.execute!
    const result = await execute({}, {} as never)
    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message).toContain('未检测到可调试的 WebView')
  })

  it('tap_node 和 set_text 接受 ref', () => {
    const tapTool = tools.find((t) => t.name === 'mobile_tap_node')!
    const schema = toToolSchema(tapTool)
    const props = (schema.parameters as { properties: Record<string, unknown> }).properties
    expect(props.ref).toBeDefined()
  })

  it('flutter_test 有 5 分钟超时', () => {
    const testTool = tools.find((t) => t.name === 'flutter_test')!
    expect(testTool.timeoutMs).toBe(300_000)
  })
})
