import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ScreenshotInfo } from '../types.js'

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return { width: 0, height: 0 }
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

export class ScreenshotStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async save(pngBuffer: Buffer): Promise<ScreenshotInfo> {
    await mkdir(this.dir, { recursive: true })
    const id = `shot-${Date.now()}-${randomBytes(3).toString('hex')}`
    const filename = `${id}.png`
    const path = join(this.dir, filename)
    await writeFile(path, pngBuffer)
    const { width, height } = readPngDimensions(pngBuffer)
    return { id, path, width, height, takenAt: Date.now() }
  }

  getPath(id: string): string {
    return join(this.dir, `${id}.png`)
  }
}
