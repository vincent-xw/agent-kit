import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AndroidKey, DeviceInfo } from '../types.js'

const execFileAsync = promisify(execFile)

const KEY_CODES: Record<AndroidKey, number> = {
  back: 4,
  home: 3,
  menu: 82,
  enter: 66,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  app_switch: 187,
  delete: 67,
  tab: 61,
  escape: 111,
  search: 84,
}

export interface AdbClientOptions {
  adbPath?: string
}

export class AdbClient {
  private readonly adbPath: string

  constructor(options: AdbClientOptions = {}) {
    this.adbPath = options.adbPath ?? 'adb'
  }

  private async exec(
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    const { stdout } = await execFileAsync(this.adbPath, args, {
      timeout: options?.timeoutMs ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    return stdout
  }

  private async execWithDevice(
    deviceSerial: string | undefined,
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    return this.exec(['-s', serial, ...args], options)
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const output = await this.exec(['devices', '-l'])
    const lines = output.split('\n').slice(1)
    const devices: DeviceInfo[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      const serial = parts[0]
      const state = parts[1]
      if (!serial || !state) continue
      if (state !== 'device' && state !== 'offline' && state !== 'unauthorized') continue
      const model = parts.find((p) => p.startsWith('model:'))?.slice(6)
      const product = parts.find((p) => p.startsWith('product:'))?.slice(8)
      devices.push({ serial, state, ...(model ? { model: model.replace(/_/g, ' ') } : {}), ...(product ? { product } : {}) })
    }
    return devices
  }

  async getDefaultSerial(): Promise<string> {
    const devices = await this.listDevices()
    const online = devices.find((d) => d.state === 'device')
    if (!online) throw new Error('没有已连接的 Android 设备')
    return online.serial
  }

  async screenshot(deviceSerial?: string): Promise<Buffer> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    const { stdout } = await execFileAsync(this.adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeout: 15_000,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'buffer',
    })
    return stdout as Buffer
  }

  async tap(x: number, y: number, deviceSerial?: string): Promise<void> {
    await this.execWithDevice(deviceSerial, ['shell', 'input', 'tap', String(x), String(y)], { timeoutMs: 10_000 })
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
    deviceSerial?: string,
  ): Promise<void> {
    await this.execWithDevice(
      deviceSerial,
      ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)],
      { timeoutMs: 15_000 },
    )
  }

  async pressKey(key: AndroidKey, deviceSerial?: string): Promise<void> {
    const keycode = KEY_CODES[key]
    if (!keycode) throw new Error(`未知按键: ${key}`)
    await this.execWithDevice(deviceSerial, ['shell', 'input', 'keyevent', String(keycode)], { timeoutMs: 10_000 })
  }

  async inputText(text: string, deviceSerial?: string): Promise<void> {
    const escaped = text.replace(/ /g, '%s')
    await this.execWithDevice(deviceSerial, ['shell', 'input', 'text', escaped], { timeoutMs: 10_000 })
  }

  async install(apkPath: string, deviceSerial?: string): Promise<void> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    await this.exec(['-s', serial, 'install', '-r', apkPath], { timeoutMs: 120_000 })
  }

  async launch(packageName: string, activity?: string, deviceSerial?: string): Promise<void> {
    if (activity) {
      await this.execWithDevice(deviceSerial, ['shell', 'am', 'start', '-n', `${packageName}/${activity}`], { timeoutMs: 15_000 })
    } else {
      await this.execWithDevice(deviceSerial, ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: 15_000 })
    }
  }

  async forceStop(packageName: string, deviceSerial?: string): Promise<void> {
    await this.execWithDevice(deviceSerial, ['shell', 'am', 'force-stop', packageName], { timeoutMs: 10_000 })
  }

  async forward(localPort: number, remoteSpec: string, deviceSerial?: string): Promise<void> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    await this.exec(['-s', serial, 'forward', `tcp:${localPort}`, remoteSpec], { timeoutMs: 10_000 })
  }

  async removeForward(localPort: number, deviceSerial?: string): Promise<void> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    await this.exec(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { timeoutMs: 10_000 })
  }

  async logcatTail(lines = 200, deviceSerial?: string): Promise<string> {
    return this.execWithDevice(deviceSerial, ['logcat', '-d', '-t', String(lines)], { timeoutMs: 10_000 })
  }

  async listWebViewSockets(deviceSerial?: string): Promise<string[]> {
    const output = await this.shell('cat', ['/proc/net/unix'], deviceSerial)
    const names: string[] = []
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const last = parts[parts.length - 1]
      if (!last || !last.startsWith('@webview_devtools_remote_')) continue
      names.push(last.slice(1))
    }
    return names
  }

  async dumpUiHierarchy(deviceSerial?: string): Promise<string> {
    const serial = deviceSerial ?? (await this.getDefaultSerial())
    // 每次用唯一文件名，并先删除，避免 uiautomator 写文件失败/超时时
    // cat 读到上一次的旧内容，导致 LLM 拿到过时的屏幕。
    const remotePath = `/sdcard/agent_ui_${Date.now()}_${Math.floor(Math.random() * 100000)}.xml`
    // uiautomator dump 需要 UI idle。持续动画（轮播、loading、启动过渡）会
    // 让 idle 永远不满足，报「could not get idle state」。此时降低单次超时、
    // 快速失败并在动画停下的间隔后重试。
    let lastError = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
      try {
        const { stdout, stderr } = await execFileAsync(
          this.adbPath,
          ['-s', serial, 'shell', 'uiautomator', 'dump', remotePath],
          { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
        )
        const dumpMsg = `${stdout}\n${stderr}`.trim()
        if (dumpMsg.includes('dumped to')) {
          const output = await this.exec(['-s', serial, 'shell', 'cat', remotePath], { timeoutMs: 10_000 })
          await this.exec(['-s', serial, 'shell', 'rm', '-f', remotePath], { timeoutMs: 5_000 }).catch(() => {})
          return output
        }
        lastError = dumpMsg || '(空输出)'
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    // 明确错误原因，让 LLM 知道是 UI 不稳定而非工具故障
    throw new Error(`uiautomator dump 失败（重试 4 次）：${lastError.slice(0, 200)}。若为 could not get idle state，说明页面持续动画，请等待动画停止后重试或改用截图/视觉分析。`)
  }

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

  async shell(command: string, args: string[], deviceSerial?: string): Promise<string> {
    return this.execWithDevice(deviceSerial, ['shell', command, ...args], { timeoutMs: 30_000 })
  }
}
