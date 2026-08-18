import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** 把 markdown 渲染为安全 HTML。 */
export function renderMarkdown(text: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(text || '', { async: false, breaks: true }) as string)
  } catch {
    return text || ''
  }
}

/** 步骤输出的简短摘要，供 UI 一行展示。 */
export function stepSummary(output: unknown): { text: string; type: 'success' | 'warning' | 'danger' | 'info' } {
  const r = (output ?? {}) as Record<string, unknown>
  if (r.ok === false) return { text: String(r.message || '失败').slice(0, 60), type: 'danger' }
  if (Array.isArray(r.entries)) return { text: `快照 ${r.entries.length} 个元素`, type: 'success' }
  if (typeof r.passed === 'boolean') return { text: r.passed ? '验证通过' : '验证未通过', type: r.passed ? 'success' : 'danger' }
  if (typeof r.satisfied === 'boolean') return { text: r.satisfied ? '等待完成' : '等待超时', type: r.satisfied ? 'success' : 'warning' }
  if (r.screenshotId) return { text: '截图已保存', type: 'success' }
  if (r.fileId) return { text: '文件已生成', type: 'success' }
  if (r.message) return { text: String(r.message).slice(0, 60), type: 'success' }
  return { text: '完成', type: 'success' }
}

/** 把未知输出转成可读字符串。 */
export function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return '(无输出)'
  try { return JSON.stringify(output, null, 2) } catch { return String(output) }
}

/** 友好的字节大小。 */
export function formatBytes(size: number): string {
  return `${(size / 1024).toFixed(1)}KB`
}

/** 从 URL 生成简洁展示文本（主域名 + 关键路径）。 */
export function shortUrlOf(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    const full = path ? `${u.host}${path}` : u.host
    return full.length > 40 ? `${full.slice(0, 40)}…` : full
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url
  }
}

/** 字典映射：writer 工具 -> 写类型，for UI 标签 */
export interface ToolDescription {
  name: string
  title: string
  category: 'read' | 'write' | 'file'
  description: string
}

export const TOOLS_CATALOG: ToolDescription[] = [
  { name: 'browser_snapshot', title: '页面快照', category: 'read', description: '获取所有可交互元素的结构化列表，每个元素带 ref 编号' },
  { name: 'browser_read_page', title: '读取页面', category: 'read', description: '读取页面正文文本与标题' },
  { name: 'browser_locate_element', title: '定位元素', category: 'read', description: '通过 ref 或 CSS selector 定位元素坐标' },
  { name: 'browser_click', title: '点击', category: 'write', description: '点击页面元素，优先使用 ref' },
  { name: 'browser_hover', title: '悬停', category: 'write', description: '鼠标悬停触发下拉菜单' },
  { name: 'browser_input_text', title: '输入文本', category: 'write', description: '在输入框中输入文本' },
  { name: 'browser_press_key', title: '按键', category: 'write', description: '按下 Enter/Tab/Escape 等键' },
  { name: 'browser_scroll', title: '滚动', category: 'write', description: '滚动页面' },
  { name: 'browser_wait_for', title: '等待', category: 'read', description: '等待元素出现/消失/DOM 稳定' },
  { name: 'browser_verify', title: '验证', category: 'read', description: '验证页面状态、对话框、网络请求' },
  { name: 'browser_screenshot', title: '截图', category: 'read', description: '截取当前视口' },
  { name: 'browser_go_back', title: '返回', category: 'write', description: '浏览器返回上一页' },
  { name: 'browser_save_file', title: '生成文件', category: 'file', description: '生成 txt/csv/xlsx/json 文件供下载' },
  { name: 'browser_read_file', title: '读取文件', category: 'file', description: '读取已保存的文本文件' },
  { name: 'browser_write_file', title: '写入文件', category: 'file', description: '将文本保存到 BFF 文件存储' },
]