import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDefinition } from '@agent-kit/core'
import type { AdbClient } from './services/adb-client.js'
import type { SnapshotProvider } from './services/device-provider.js'
import type { FlutterProcessManager } from './services/flutter-process-manager.js'
import type { VmServiceClient } from './services/vm-service-client.js'
import type { ScreenshotStore } from './services/screenshot-store.js'
import type { CdpClient } from './services/webview/cdp-client.js'
import type { VisionClient } from './services/vision-client.js'
import type { AndroidKey } from './types.js'

const execFileAsync = promisify(execFile)

export interface FlutterToolServices {
  adb: AdbClient
  device: SnapshotProvider
  flutter: FlutterProcessManager
  vm: {
    current: VmServiceClient | null
    connect(uri: string): Promise<VmServiceClient>
    disconnect(): void
  }
  screenshots: ScreenshotStore
  projectPath: string
  webView: CdpClient
  /** 视觉模型客户端，用于截图分析。未配置时此字段为 undefined。 */
  vision?: VisionClient
}

function createDeviceTools(svc: FlutterToolServices): ToolDefinition[] {
  return [
    {
      name: 'mobile_devices',
      execution: 'server',
      description: '列出所有已连接的 Android 设备/模拟器。优先调用此工具确认设备可用。',
      input: z.object({}),
      output: z.object({
        devices: z.array(z.object({
          serial: z.string(),
          state: z.string(),
          model: z.string().optional(),
          product: z.string().optional(),
        })),
        count: z.number(),
      }),
      timeoutMs: 10_000,
      async execute() {
        const devices = await svc.adb.listDevices()
        return { devices, count: devices.length }
      },
    },
    {
      name: 'mobile_app_install',
      execution: 'server',
      description: '安装 APK 文件到设备。',
      input: z.object({
        apkPath: z.string().describe('APK 文件的绝对路径'),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 120_000,
      async execute(raw) {
        const { apkPath, deviceSerial } = raw as { apkPath: string; deviceSerial?: string }
        await svc.adb.install(apkPath, deviceSerial)
        return { ok: true, message: '安装成功' }
      },
    },
    {
      name: 'mobile_app_launch',
      execution: 'server',
      description: '启动指定包名的应用。不指定 activity 时用 monkey 启动 LAUNCHER。',
      input: z.object({
        packageName: z.string(),
        activity: z.string().optional(),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 15_000,
      async execute(raw) {
        const { packageName, activity, deviceSerial } = raw as {
          packageName: string; activity?: string; deviceSerial?: string
        }
        await svc.adb.launch(packageName, activity, deviceSerial)
        return { ok: true, message: `已启动 ${packageName}` }
      },
    },
    {
      name: 'mobile_app_stop',
      execution: 'server',
      description: '强制停止指定包名的应用。',
      input: z.object({
        packageName: z.string(),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { packageName, deviceSerial } = raw as { packageName: string; deviceSerial?: string }
        await svc.adb.forceStop(packageName, deviceSerial)
        return { ok: true, message: `已停止 ${packageName}` }
      },
    },
    {
      name: 'mobile_screenshot',
      execution: 'server',
      description: '截取设备屏幕并保存。截图对用户可见，但你看不到图片内容。了解屏幕布局请用 mobile_snapshot。',
      input: z.object({
        deviceSerial: z.string().optional(),
      }),
      output: z.object({
        screenshotId: z.string(),
        width: z.number(),
        height: z.number(),
        message: z.string(),
      }),
      timeoutMs: 15_000,
      async execute(raw) {
        const { deviceSerial } = raw as { deviceSerial?: string }
        const buffer = await svc.adb.screenshot(deviceSerial)
        const info = await svc.screenshots.save(buffer)
        return {
          screenshotId: info.id,
          width: info.width,
          height: info.height,
          message: '截图已保存，用户可以在对话中查看',
        }
      },
    },
    {
      name: 'mobile_screen_analyze',
      execution: 'server',
      description:
        '截图并调用视觉模型分析屏幕内容，返回文字描述。当 mobile_snapshot 返回的节点较少或没有有用信息时使用（例如页面含有大量图标、图片、自定义绘制控件）。描述中不包含可点击的 ref，需要结合 mobile_snapshot 的节点信息一起判断。',
      input: z.object({
        deviceSerial: z.string().optional(),
      }),
      output: z.object({
        ok: z.boolean(),
        description: z.string().optional(),
        message: z.string(),
      }),
      timeoutMs: 130_000,
      async execute(raw) {
        if (!svc.vision) {
          return { ok: false, message: '未配置视觉模型。请设置 VISION_API_KEY、VISION_MODEL 和 VISION_BASE_URL 环境变量。' }
        }
        const { deviceSerial } = raw as { deviceSerial?: string }
        const buffer = await svc.adb.screenshot(deviceSerial)
        const base64 = buffer.toString('base64')
        const description = await svc.vision.analyze(base64)
        return { ok: true, description, message: '截图已分析' }
      },
    },
  ]
}

const nodeSchema = z.object({
  ref: z.number(),
  bounds: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }),
  clickable: z.boolean(),
  scrollable: z.boolean(),
  editable: z.boolean(),
  enabled: z.boolean(),
  focused: z.boolean(),
  text: z.string().optional(),
  contentDescription: z.string().optional(),
  className: z.string().optional(),
  resourceId: z.string().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
})

function createAccessibilityTools(svc: FlutterToolServices): ToolDefinition[] {
  return [
    {
      name: 'mobile_snapshot',
      execution: 'server',
      description:
        '获取当前屏幕的节点树（无障碍树），返回所有可交互节点和有文本的节点。这是所有 UI 操作的起点：先快照看清屏幕内容，再用 ref 指定目标。UI 变化后必须重新快照。',
      input: z.object({}),
      output: z.object({
        snapshotId: z.string(),
        packageName: z.string(),
        screenWidth: z.number(),
        screenHeight: z.number(),
        nodes: z.array(nodeSchema),
        truncated: z.number().optional(),
      }),
      timeoutMs: 30_000,
      async execute() {
        return svc.device.snapshot()
      },
    },
    {
      name: 'mobile_tap_node',
      execution: 'server',
      description: '点击快照中的指定节点。优先使用此工具而非坐标点击。操作后应重新快照验证效果。',
      input: z.object({
        ref: z.number().int().describe('来自 mobile_snapshot 的节点 ref'),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { ref } = raw as { ref: number }
        return svc.device.tapNode(ref)
      },
    },
    {
      name: 'mobile_set_text',
      execution: 'server',
      description: '向可编辑节点设置文本，会先清空原有内容再输入。优先使用此工具而非坐标操作。中文等非 ASCII 文本需要设备已启用 ADBKeyBoard 输入法；未启用时本工具会返回包含设置命令的错误信息，ASCII 文本不受影响。',
      input: z.object({
        ref: z.number().int(),
        text: z.string().describe('要设置的完整文本'),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { ref, text } = raw as { ref: number; text: string }
        return svc.device.setText(ref, text)
      },
    },
    {
      name: 'mobile_scroll_node',
      execution: 'server',
      description: '在可滚动节点内滚动。滚动后需要重新快照。',
      input: z.object({
        ref: z.number().int(),
        direction: z.enum(['forward', 'backward']),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { ref, direction } = raw as { ref: number; direction: 'forward' | 'backward' }
        return svc.device.scrollNode(ref, direction)
      },
    },
    {
      name: 'mobile_wait_for',
      execution: 'server',
      description: '等待屏幕上出现包含指定文本的节点。超时不代表错误，satisfied=false 时重新快照评估现状。',
      input: z.object({
        text: z.string(),
        timeoutMs: z.number().int().min(1000).max(30000).optional(),
      }),
      output: z.object({
        satisfied: z.boolean(),
        waitedMs: z.number(),
        observed: z.string(),
      }),
      timeoutMs: 35_000,
      async execute(raw, context) {
        const { text, timeoutMs = 10_000 } = raw as { text: string; timeoutMs?: number }
        const start = Date.now()
        const interval = 800
        while (Date.now() - start < timeoutMs) {
          // 响应 harness 取消：否则工具级 timeoutMs abort 后循环仍继续跑满整个超时
          if (context.signal.aborted) {
            return { satisfied: false, waitedMs: Date.now() - start, observed: `已中断（未找到包含「${text}」的节点）` }
          }
          const snapshot = await svc.device.snapshot()
          const found = snapshot.nodes.some(
            (n) => n.text?.includes(text) || n.contentDescription?.includes(text),
          )
          if (found) {
            return { satisfied: true, waitedMs: Date.now() - start, observed: `找到包含「${text}」的节点` }
          }
          await new Promise((r) => setTimeout(r, interval))
        }
        return { satisfied: false, waitedMs: Date.now() - start, observed: `超时未找到包含「${text}」的节点` }
      },
    },
    {
      name: 'mobile_press_key',
      execution: 'server',
      description: '发送 Android 系统按键。',
      input: z.object({
        key: z.enum(['back', 'home', 'menu', 'enter', 'volume_up', 'volume_down', 'power', 'app_switch', 'delete', 'tab', 'escape', 'search']),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { key, deviceSerial } = raw as { key: AndroidKey; deviceSerial?: string }
        await svc.adb.pressKey(key, deviceSerial)
        // 按键（尤其是 back/home）会触发页面切换动画，短暂等待让无障碍树更新
        await new Promise((r) => setTimeout(r, 300))
        return { ok: true, message: `已发送按键 ${key}` }
      },
    },
  ]
}

function createCoordinateTools(svc: FlutterToolServices): ToolDefinition[] {
  return [
    {
      name: 'mobile_tap',
      execution: 'server',
      description: '按坐标点击屏幕（降级方案）。仅在 mobile_snapshot 没有目标节点时使用。坐标原点在左上角。',
      input: z.object({
        x: z.number().int(),
        y: z.number().int(),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        const { x, y, deviceSerial } = raw as { x: number; y: number; deviceSerial?: string }
        await svc.adb.tap(x, y, deviceSerial)
        return { ok: true, message: `已点击 (${x}, ${y})` }
      },
    },
    {
      name: 'mobile_swipe',
      execution: 'server',
      description: '在两个坐标之间滑动（降级方案）。优先使用 mobile_scroll_node 滚动。',
      input: z.object({
        x1: z.number().int(),
        y1: z.number().int(),
        x2: z.number().int(),
        y2: z.number().int(),
        durationMs: z.number().int().min(50).max(5000).optional(),
        deviceSerial: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 15_000,
      async execute(raw) {
        const { x1, y1, x2, y2, durationMs = 300, deviceSerial } = raw as {
          x1: number; y1: number; x2: number; y2: number; durationMs?: number; deviceSerial?: string
        }
        await svc.adb.swipe(x1, y1, x2, y2, durationMs, deviceSerial)
        return { ok: true, message: `已滑动 (${x1},${y1}) -> (${x2},${y2})` }
      },
    },
  ]
}

function createWebTools(svc: FlutterToolServices): ToolDefinition[] {
  const unavailable = {
    ok: false,
    message:
      '未检测到可调试的 WebView。该 App 可能未开启 WebView 调试；网页的可见内容可通过 mobile_snapshot 查看无障碍树。',
  }
  return [
    {
      name: 'web_snapshot',
      execution: 'server',
      description:
        '获取当前屏幕上 WebView 内的网页节点树（通过 Chrome DevTools Protocol）。当 mobile_snapshot 看到 WebView 节点、需要操作其中的网页元素时使用。返回与 mobile_snapshot 同构的节点，但 ref 独立编号。若 WebView 未开启调试会返回错误。',
      input: z.object({}),
      output: z.object({
        snapshotId: z.string(),
        packageName: z.string(),
        screenWidth: z.number(),
        screenHeight: z.number(),
        nodes: z.array(nodeSchema),
      }),
      timeoutMs: 15_000,
      async execute() {
        if (!(await svc.webView.isAvailable())) return unavailable
        return svc.webView.snapshot()
      },
    },
    {
      name: 'web_tap',
      execution: 'server',
      description: '点击 web_snapshot 中的指定网页节点。操作后应重新 web_snapshot 验证效果。',
      input: z.object({
        ref: z.number().int().describe('来自 web_snapshot 的节点 ref'),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        if (!(await svc.webView.isAvailable())) return unavailable
        const { ref } = raw as { ref: number }
        await svc.webView.tap(ref)
        return { ok: true, message: '已点击网页元素' }
      },
    },
    {
      name: 'web_set_text',
      execution: 'server',
      description: '向 web_snapshot 中的可编辑网页节点设置文本（会先清空）。通过 CDP 输入，直接支持中文等 Unicode。',
      input: z.object({
        ref: z.number().int().describe('来自 web_snapshot 的节点 ref'),
        text: z.string().describe('要设置的完整文本'),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        if (!(await svc.webView.isAvailable())) return unavailable
        const { ref, text } = raw as { ref: number; text: string }
        await svc.webView.setText(ref, text)
        return { ok: true, message: `已设置文本（${text.length} 字符）` }
      },
    },
    {
      name: 'web_scroll',
      execution: 'server',
      description: '滚动 web_snapshot 中的指定可滚动网页节点。',
      input: z.object({
        ref: z.number().int(),
        direction: z.enum(['forward', 'backward']),
      }),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 10_000,
      async execute(raw) {
        if (!(await svc.webView.isAvailable())) return unavailable
        const { ref, direction } = raw as { ref: number; direction: 'forward' | 'backward' }
        await svc.webView.scroll(ref, direction)
        return { ok: true, message: `已滚动 ${direction}` }
      },
    },
  ]
}

function createFlutterTools(svc: FlutterToolServices): ToolDefinition[] {
  return [
    {
      name: 'flutter_run_start',
      execution: 'server',
      description: '在设备上启动 Flutter 应用（debug 模式）。自动连接 VM Service 以支持热重载和表达式求值。同一时间只能运行一个实例。',
      input: z.object({
        deviceSerial: z.string().optional(),
        target: z.string().optional().describe('Dart 入口文件，如 lib/main.dart'),
        flavor: z.string().optional(),
      }),
      output: z.object({
        ok: z.boolean(),
        message: z.string(),
        processId: z.number().optional(),
        vmServiceUri: z.string().optional(),
      }),
      timeoutMs: 120_000,
      async execute(raw) {
        const opts = raw as { deviceSerial?: string; target?: string; flavor?: string }
        try {
          const info = await svc.flutter.start({
            ...(opts.deviceSerial ? { deviceSerial: opts.deviceSerial } : {}),
            ...(opts.target ? { target: opts.target } : {}),
            ...(opts.flavor ? { flavor: opts.flavor } : {}),
          })
          await svc.vm.connect(info.vmServiceUri)
          return {
            ok: true,
            processId: info.processId,
            vmServiceUri: info.vmServiceUri,
            message: 'Flutter 应用已启动，VM Service 已连接',
          }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : '启动失败' }
        }
      },
    },
    {
      name: 'flutter_run_stop',
      execution: 'server',
      description: '停止正在运行的 Flutter 应用。',
      input: z.object({}),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 20_000,
      async execute() {
        svc.vm.disconnect()
        await svc.flutter.stop()
        return { ok: true, message: 'Flutter 应用已停止' }
      },
    },
    {
      name: 'flutter_hot_reload',
      execution: 'server',
      description: '热重载运行中的 Flutter 应用。代码修改后调用，然后重新快照验证 UI 变化。',
      input: z.object({}),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 30_000,
      async execute() {
        if (svc.vm.current) {
          const result = await svc.vm.current.reloadSources()
          if (!result.ok) svc.flutter.hotReload()
          return result
        }
        if (!svc.flutter.isRunning()) {
          return { ok: false, message: 'Flutter 应用未运行，请先调用 flutter_run_start' }
        }
        svc.flutter.hotReload()
        return { ok: true, message: '热重载已触发（stdin 模式）' }
      },
    },
    {
      name: 'flutter_hot_restart',
      execution: 'server',
      description: '热重启 Flutter 应用（重置 Dart 状态）。状态异常时使用。',
      input: z.object({}),
      output: z.object({ ok: z.boolean(), message: z.string() }),
      timeoutMs: 30_000,
      async execute() {
        if (!svc.flutter.isRunning()) {
          return { ok: false, message: 'Flutter 应用未运行，请先调用 flutter_run_start' }
        }
        svc.flutter.hotRestart()
        return { ok: true, message: '热重启已触发' }
      },
    },
    {
      name: 'flutter_logs',
      execution: 'server',
      description: '读取 Flutter 应用的最近运行日志。动作后调用以验证效果或排查错误。',
      input: z.object({
        count: z.number().int().min(1).max(500).optional(),
      }),
      output: z.object({
        logs: z.array(z.object({
          timestamp: z.number(),
          level: z.string(),
          text: z.string(),
        })),
        total: z.number(),
      }),
      timeoutMs: 5_000,
      async execute(raw) {
        const { count = 100 } = (raw as { count?: number }) ?? {}
        const logs = svc.flutter.getRecentLogs(count)
        return { logs, total: logs.length }
      },
    },
    {
      name: 'flutter_analyze',
      execution: 'server',
      description: '运行 flutter analyze 检查静态问题。返回问题列表。',
      input: z.object({
        path: z.string().optional(),
      }),
      output: z.object({
        ok: z.boolean(),
        issues: z.array(z.object({
          severity: z.enum(['error', 'warning', 'info']),
          file: z.string(),
          line: z.number(),
          column: z.number().optional(),
          message: z.string(),
          code: z.string().optional(),
        })),
        issueCount: z.number(),
      }),
      timeoutMs: 120_000,
      async execute(raw) {
        const { path: subPath } = raw as { path?: string }
        const args = ['analyze', '--no-pub']
        if (subPath) args.push(subPath)
        let output = ''
        try {
          const result = await execFileAsync('flutter', args, {
            cwd: svc.projectPath,
            timeout: 110_000,
            maxBuffer: 5 * 1024 * 1024,
          })
          output = result.stdout + result.stderr
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string }
          output = (e.stdout ?? '') + (e.stderr ?? '')
        }
        const issues: Array<{ severity: 'error'|'warning'|'info'; file: string; line: number; column?: number; message: string; code?: string }> = []
        const lineRegex = /^\s+(error|warning|info)\s+•\s+(.*?)\s+•\s+(.*?):(\d+):(\d+)\s+•\s+(.*)$/gm
        let match: RegExpExecArray | null
        while ((match = lineRegex.exec(output)) !== null) {
          issues.push({
            severity: match[1] as 'error' | 'warning' | 'info',
            message: match[2] ?? '',
            file: match[3] ?? '',
            line: Number(match[4]),
            column: Number(match[5]),
            ...(match[6] ? { code: match[6] } : {}),
          })
        }
        return { ok: !issues.some((i) => i.severity === 'error'), issues, issueCount: issues.length }
      },
    },
    {
      name: 'flutter_test',
      execution: 'server',
      description: '运行 Flutter 测试。不指定 target 时运行全部测试。可能需要较长时间（最多 5 分钟）。',
      input: z.object({
        target: z.string().optional(),
        name: z.string().optional(),
      }),
      output: z.object({
        passed: z.boolean(),
        total: z.number(),
        passedCount: z.number(),
        failedCount: z.number(),
        durationMs: z.number(),
        failures: z.array(z.object({
          testName: z.string(),
          error: z.string(),
        })),
      }),
      timeoutMs: 300_000,
      async execute(raw) {
        const { target, name } = raw as { target?: string; name?: string }
        const args = ['test', '--reporter', 'json', '--no-pub']
        if (target) args.push(target)
        if (name) args.push('--plain-name', name)
        const startedAt = Date.now()
        let stdout = ''
        try {
          const result = await execFileAsync('flutter', args, {
            cwd: svc.projectPath,
            timeout: 290_000,
            maxBuffer: 20 * 1024 * 1024,
          })
          stdout = result.stdout + result.stderr
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string }
          stdout = (e.stdout ?? '') + (e.stderr ?? '')
        }
        interface TestEvent { type: string; testID?: number; result?: string; error?: string; name?: string }
        const events = stdout.split('\n')
          .filter((l) => l.trim())
          .map((l) => { try { return JSON.parse(l) as TestEvent } catch { return null } })
          .filter((e): e is TestEvent => e !== null)
        const tests = new Map<number, { name: string; result?: string; error?: string }>()
        for (const e of events) {
          if (e.type === 'testStart' && e.testID && e.name) {
            tests.set(e.testID, { name: e.name })
          } else if (e.type === 'testDone' && e.testID) {
            const t = tests.get(e.testID)
            if (t && e.result) t.result = e.result
          } else if (e.type === 'error' && e.testID) {
            const t = tests.get(e.testID)
            if (t && e.error) t.error = e.error
          }
        }
        const testList = [...tests.values()].filter((t) => t.result)
        const failed = testList.filter((t) => t.result !== 'success')
        return {
          passed: failed.length === 0,
          total: testList.length,
          passedCount: testList.length - failed.length,
          failedCount: failed.length,
          durationMs: Date.now() - startedAt,
          failures: failed.map((t) => ({ testName: t.name, error: t.error ?? '未知错误' })),
        }
      },
    },
    {
      name: 'flutter_eval',
      execution: 'server',
      description:
        '在运行中的 Flutter 应用里执行 Dart 表达式。debugDumpApp() 输出到日志（用 flutter_logs 读取）。toStringDeep() 直接返回字符串。需要先调用 flutter_run_start。',
      input: z.object({
        expression: z.string(),
      }),
      output: z.object({
        result: z.string().optional(),
        error: z.string().optional(),
      }),
      timeoutMs: 15_000,
      async execute(raw) {
        const { expression } = raw as { expression: string }
        if (!svc.vm.current) {
          return { error: 'VM Service 未连接，请先调用 flutter_run_start' }
        }
        return svc.vm.current.evaluate(expression)
      },
    },
  ]
}

export function createFlutterToolDefinitions(svc: FlutterToolServices): ToolDefinition[] {
  return [
    ...createAccessibilityTools(svc),
    ...createDeviceTools(svc),
    ...createCoordinateTools(svc),
    ...createWebTools(svc),
    ...createFlutterTools(svc),
  ]
}
