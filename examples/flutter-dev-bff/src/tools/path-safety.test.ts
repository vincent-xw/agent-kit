import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertInsideRoot } from './path-safety.js'

const root = join(tmpdir(), 'ak-root-test')

describe('assertInsideRoot', () => {
  it('相对路径落在根内', () => {
    expect(assertInsideRoot(root, 'a/b.txt')).toBe(join(root, 'a/b.txt'))
  })
  it('根内绝对路径放行', () => {
    expect(assertInsideRoot(root, join(root, 'x'))).toBe(join(root, 'x'))
  })
  it('.. 逃逸被拒', () => {
    expect(() => assertInsideRoot(root, '../evil')).toThrow(/outside workspace/)
    expect(() => assertInsideRoot(root, join(root, '..', 'evil'))).toThrow(/outside workspace/)
  })
  it('根外绝对路径被拒', () => {
    expect(() => assertInsideRoot(root, join(tmpdir(), 'other'))).toThrow(/outside workspace/)
  })
  it('根自身放行', () => {
    expect(assertInsideRoot(root, root)).toBe(root)
  })
})