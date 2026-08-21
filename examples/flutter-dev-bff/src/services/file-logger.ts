import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FileLogConfig } from './log-format.js'

export interface FileLoggerHandle {
  sink: { log(message: string): void }
  close(): Promise<void>
}

/** 按日轮转写入器：append 到 bff-YYYY-MM-DD.log，跨天自动换文件，按 keepDays 清理。 */
export function createFileLogger(config: FileLogConfig): FileLoggerHandle {
  // 目录缺失直接建；失败抛给调用方降级（不阻断 BFF 启动）
  mkdirSync(config.dir, { recursive: true })
  const transport = new DailyRotateFile({
    filename: `${join(config.dir, 'bff')}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    // keepDays=0 时不传 maxFiles，即永久保留
    ...(config.keepDays > 0 ? { maxFiles: String(config.keepDays) } : {}),
    format: winston.format.printf((info) => (typeof info.message === 'string' ? info.message : '')),
  })
  const logger = winston.createLogger({ level: 'info', transports: [transport], exitOnError: false })
  return {
    sink: { log(message: string) { logger.log({ level: 'info', message }) } },
    close() {
      return new Promise<void>((resolve) => {
        const done = () => resolve()
        transport.once('closed', done)
        transport.close(() => done())
        // 兜底：避免某些状态下 close 回调永不触发而挂起
        setTimeout(done, 1000)
      })
    },
  }
}