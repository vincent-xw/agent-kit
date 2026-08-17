import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 文件存储服务。
 *
 * 替代原插件的 IndexedDB：所有 agent 生成的文件、上传的文件、截图都存到 BFF 进程所在目录。
 * - 文本文件（txt/csv/json/md）内容可被 read_file 读取，也可勾选注入上下文
 * - 二进制文件（xlsx/png/jpeg）只能下载，不进 LLM 上下文
 * - 截图由 WS 执行器返回 base64 后存盘，模型只拿到 screenshotId
 */

export interface StoredFile {
  id: string
  filename: string
  size: number
  createdAt: string
  format: string
  isImage: boolean
  width?: number
  height?: number
  /** 文本内容，仅文本格式有 */
  text?: string
}

export interface FileStorageOptions {
  dataDir?: string
}

export function createFileStorage(options: FileStorageOptions = {}) {
  const dataDir = options.dataDir ?? join(process.cwd(), 'data', 'files')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  function makeId(): string {
    return `file-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  }

  function saveTextFile(name: string, content: string): StoredFile {
    const id = makeId()
    const ext = extname(name).slice(1) || 'txt'
    const buffer = Buffer.from(content, 'utf-8')
    const filePath = join(dataDir, `${id}.bin`)
    writeFileSync(filePath, buffer)
    const file: StoredFile = {
      id,
      filename: name,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      format: ext,
      isImage: false,
      text: content,
    }
    writeMeta(file)
    return file
  }

  function saveGeneratedFile(name: string, format: string, content: string): StoredFile {
    // 对于 xlsx，content 是 base64 编码的二进制
    const id = makeId()
    let buffer: Buffer
    let text: string | undefined
    if (format === 'xlsx') {
      buffer = Buffer.from(content, 'base64')
    } else {
      buffer = Buffer.from(content, 'utf-8')
      text = content
    }
    const filename = name.includes('.') ? name : `${name}.${format}`
    const filePath = join(dataDir, `${id}.bin`)
    writeFileSync(filePath, buffer)
    const file: StoredFile = {
      id,
      filename,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      format,
      isImage: false,
      ...(text ? { text } : {}),
    }
    writeMeta(file)
    return file
  }

  function saveScreenshot(dataUrl: string, width: number, height: number): StoredFile {
    const id = makeId()
    const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    const format = matches?.[1] ?? 'png'
    const base64 = matches?.[2] ?? ''
    const buffer = Buffer.from(base64, 'base64')
    writeFileSync(join(dataDir, `${id}.bin`), buffer)
    const file: StoredFile = {
      id,
      filename: `screenshot-${id}.${format}`,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      format,
      isImage: true,
      width,
      height,
    }
    writeMeta(file)
    return file
  }

  function readFile(name: string): { ok: boolean; content?: string; size?: number; truncated?: boolean; totalLength?: number; message: string; name?: string } {
    // 按文件名查找
    const files = listFiles()
    const found = files.find(f => f.filename === name || f.filename.startsWith(name))
    if (!found) {
      return { ok: false, message: `文件「${name}」不存在。可用文件列表请参考上下文中的 fileList。` }
    }
    if (found.isImage) {
      return { ok: false, message: `「${name}」是图片文件，不能读取文本内容。` }
    }
    const meta = readMeta(found.id)
    if (!meta?.text) {
      // 从磁盘读取
      try {
        const content = readFileSync(join(dataDir, `${found.id}.bin`), 'utf-8')
        const maxChars = 50000
        const truncated = content.length > maxChars
        return {
          ok: true,
          name: found.filename,
          content: truncated ? content.slice(0, maxChars) : content,
          size: Buffer.byteLength(content),
          ...(truncated ? { truncated: true, totalLength: content.length } : {}),
          message: truncated ? `文件「${name}」共 ${content.length} 字符，已返回前 ${maxChars} 字符。` : `文件「${name}」读取成功，共 ${content.length} 字符。`,
        }
      } catch (error) {
        return { ok: false, message: `读取文件失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const maxChars = 50000
    const truncated = meta.text.length > maxChars
    return {
      ok: true,
      name: found.filename,
      content: truncated ? meta.text.slice(0, maxChars) : meta.text,
      size: meta.size,
      ...(truncated ? { truncated: true, totalLength: meta.text.length } : {}),
      message: truncated ? `文件「${name}」共 ${meta.text.length} 字符，已返回前 ${maxChars} 字符。` : `文件「${name}」读取成功，共 ${meta.text.length} 字符。`,
    }
  }

  function listFiles(): StoredFile[] {
    if (!existsSync(dataDir)) return []
    const files: StoredFile[] = []
    for (const entry of readdirSync(dataDir)) {
      if (!entry.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(readFileSync(join(dataDir, entry), 'utf-8')) as StoredFile
        files.push(meta)
      } catch { /* skip corrupt meta */ }
    }
    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function getFilePath(id: string): string | null {
    const p = join(dataDir, `${id}.bin`)
    return existsSync(p) ? p : null
  }

  function getFile(id: string): StoredFile | null {
    return readMeta(id)
  }

  function deleteFile(id: string): boolean {
    const binPath = join(dataDir, `${id}.bin`)
    const metaPath = join(dataDir, `${id}.meta.json`)
    let deleted = false
    if (existsSync(binPath)) { unlinkSync(binPath); deleted = true }
    if (existsSync(metaPath)) { unlinkSync(metaPath); deleted = true }
    return deleted
  }

  function writeMeta(file: StoredFile): void {
    writeFileSync(join(dataDir, `${file.id}.meta.json`), JSON.stringify(file, null, 2))
  }

  function readMeta(id: string): StoredFile | null {
    const p = join(dataDir, `${id}.meta.json`)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, 'utf-8')) as StoredFile } catch { return null }
  }

  /** 构建 fileList 上下文：列出文本文件的名称和大小。 */
  function buildFileList(): Array<{ name: string; size: number }> {
    return listFiles()
      .filter(f => !f.isImage && f.format !== 'xlsx')
      .map(f => ({ name: f.filename, size: f.size }))
  }

  return {
    saveTextFile,
    saveGeneratedFile,
    saveScreenshot,
    readFile,
    listFiles,
    getFilePath,
    getFile,
    deleteFile,
    buildFileList,
    dataDir,
  }
}

export type FileStorage = ReturnType<typeof createFileStorage>