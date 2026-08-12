import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { FlutterLogEntry, FlutterRunInfo } from '../types.js'

const VM_SERVICE_RE = /A Dart VM Service .* is available at: (\S+)/

export interface FlutterProcessManagerOptions {
  projectPath: string
  flutterPath?: string
  logBufferSize?: number
}

export class FlutterProcessManager {
  private process: ChildProcess | null = null
  private logBuffer: FlutterLogEntry[] = []
  private vmServiceUri: string | null = null
  private runInfo: FlutterRunInfo | null = null
  private exitHandlers: Array<(code: number | null) => void> = []
  private readonly bufferSize: number
  private readonly projectPath: string
  private readonly flutterPath: string

  constructor(options: FlutterProcessManagerOptions) {
    this.projectPath = options.projectPath
    this.flutterPath = options.flutterPath ?? 'flutter'
    this.bufferSize = options.logBufferSize ?? 500
  }

  start(options: {
    deviceSerial?: string
    target?: string
    flavor?: string
  }): Promise<FlutterRunInfo> {
    if (this.process) {
      return Promise.reject(new Error('Flutter 应用已在运行中，请先停止'))
    }

    const args = ['run']
    if (options.deviceSerial) args.push('-d', options.deviceSerial)
    if (options.target) args.push('-t', options.target)
    if (options.flavor) args.push('--flavor', options.flavor)

    return new Promise((resolve, reject) => {
      const child = spawn(this.flutterPath, args, {
        cwd: this.projectPath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process = child

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('flutter run 启动超时（120秒）'))
      }, 120_000)

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        this.appendLog('stdout', text)
        const match = text.match(VM_SERVICE_RE)
        if (match && match[1] && !this.vmServiceUri) {
          clearTimeout(timeout)
          this.vmServiceUri = match[1]
          this.runInfo = {
            processId: child.pid ?? 0,
            vmServiceUri: match[1],
            deviceSerial: options.deviceSerial ?? '',
            startedAt: Date.now(),
          }
          resolve(this.runInfo)
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        this.appendLog('stderr', data.toString())
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        this.process = null
        reject(err)
      })

      child.on('exit', (code) => {
        clearTimeout(timeout)
        this.process = null
        this.vmServiceUri = null
        this.runInfo = null
        for (const handler of this.exitHandlers) handler(code)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.process) return
    return new Promise((resolve) => {
      const child = this.process!
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.process = null
        this.vmServiceUri = null
        this.runInfo = null
        resolve()
      }
      child.on('exit', finish)
      child.stdin?.write('q\n')
      setTimeout(() => {
        if (!settled) child.kill('SIGTERM')
      }, 5_000)
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 10_000)
      setTimeout(finish, 12_000)
    })
  }

  isRunning(): boolean {
    return this.process !== null
  }

  getInfo(): FlutterRunInfo | null {
    return this.runInfo
  }

  getVmServiceUri(): string | null {
    return this.vmServiceUri
  }

  hotReload(): void {
    this.process?.stdin?.write('r')
  }

  hotRestart(): void {
    this.process?.stdin?.write('R')
  }

  getRecentLogs(count = 100): FlutterLogEntry[] {
    return this.logBuffer.slice(-count)
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter((h) => h !== handler)
    }
  }

  private appendLog(level: 'stdout' | 'stderr', text: string): void {
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    const now = Date.now()
    for (const line of lines) {
      this.logBuffer.push({ timestamp: now, level, text: line })
    }
    if (this.logBuffer.length > this.bufferSize) {
      this.logBuffer.splice(0, this.logBuffer.length - this.bufferSize)
    }
  }
}
