import { resolve, sep } from 'node:path'

/** 把 path 解析进 root 内的绝对路径；越权（.. 逃逸/落在根外）抛 Error。 */
export function assertInsideRoot(root: string, path: string): string {
  const abs = resolve(root, path)
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path outside workspace: ${path}`)
  }
  return abs
}