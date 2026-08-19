import { describe, expect, it, vi } from 'vitest'
import { FallbackSnapshotProvider } from './fallback-provider.js'
import type { CompanionProvider } from './companion-provider.js'
import type { UiAutomatorDumpProvider } from './uiautomator-provider.js'
import type { DeviceSnapshot } from '../types.js'

const snap = (source: DeviceSnapshot['source'], pkg = 'com.test'): DeviceSnapshot => ({
  snapshotId: 's',
  packageName: pkg,
  screenWidth: 0,
  screenHeight: 0,
  nodes: [],
  source,
})

function makeProviders(cooldown = 100) {
  const companion = {
    snapshot: vi.fn(async () => snap('companion')),
    tapNode: vi.fn(async () => ({ ok: true, message: 'companion' })),
    setText: vi.fn(async () => ({ ok: true, message: 'companion' })),
    scrollNode: vi.fn(async () => ({ ok: true, message: 'companion' })),
  } as unknown as CompanionProvider
  const uiautomator = {
    snapshot: vi.fn(async () => snap('uiautomator')),
    tapNode: vi.fn(async () => ({ ok: true, message: 'uiautomator' })),
    setText: vi.fn(async () => ({ ok: true, message: 'uiautomator' })),
    scrollNode: vi.fn(async () => ({ ok: true, message: 'uiautomator' })),
  } as unknown as UiAutomatorDumpProvider
  const provider = new FallbackSnapshotProvider(companion, uiautomator, { degradeCooldownMs: cooldown })
  return { companion, uiautomator, provider }
}

describe('FallbackSnapshotProvider', () => {
  it('Companion 正常时优先用 Companion', async () => {
    const { companion, provider } = makeProviders()
    const s = await provider.snapshot()
    expect(s.source).toBe('companion')
    expect(companion.snapshot).toHaveBeenCalled()
  })

  it('Companion 失败时降级到 uiautomator', async () => {
    const { companion, provider } = makeProviders()
    vi.mocked(companion.snapshot).mockRejectedValueOnce(new Error('connection refused'))
    const s = await provider.snapshot()
    expect(s.source).toBe('uiautomator')
  })

  it('降级后 tap/setText/scroll 走 uiautomator，ref 保持一致', async () => {
    const { companion, uiautomator, provider } = makeProviders()
    vi.mocked(companion.snapshot).mockRejectedValueOnce(new Error('down'))
    await provider.snapshot()

    await provider.tapNode(1)
    await provider.setText(2, 'x')
    await provider.scrollNode(3, 'forward')

    expect(uiautomator.tapNode).toHaveBeenCalledWith(1)
    expect(uiautomator.setText).toHaveBeenCalledWith(2, 'x')
    expect(uiautomator.scrollNode).toHaveBeenCalledWith(3, 'forward')
    expect(companion.tapNode).not.toHaveBeenCalled()
  })

  it('冷却期内持续用 uiautomator，不重复尝试 Companion', async () => {
    const { companion, uiautomator, provider } = makeProviders()
    vi.mocked(companion.snapshot).mockRejectedValueOnce(new Error('down'))
    await provider.snapshot()

    const s2 = await provider.snapshot()
    expect(s2.source).toBe('uiautomator')
    expect(companion.snapshot).toHaveBeenCalledTimes(1) // 只在第一次尝试过
    expect(uiautomator.snapshot).toHaveBeenCalledTimes(2)
  })

  it('冷却期结束后自动恢复 Companion', async () => {
    const { companion, provider } = makeProviders()
    vi.mocked(companion.snapshot).mockRejectedValueOnce(new Error('down'))
    await provider.snapshot()

    // 手动跳过冷却
    await new Promise((r) => setTimeout(r, 150))
    const s = await provider.snapshot()
    expect(s.source).toBe('companion')
  })

  it('恢复后操作走 Companion', async () => {
    const { companion, uiautomator, provider } = makeProviders()
    vi.mocked(companion.snapshot).mockRejectedValueOnce(new Error('down'))
    await provider.snapshot()
    await new Promise((r) => setTimeout(r, 150))
    await provider.snapshot()

    await provider.tapNode(5)
    expect(companion.tapNode).toHaveBeenCalledWith(5)
    expect(uiautomator.tapNode).not.toHaveBeenCalled()
  })
})