import type { SnapshotProvider } from './device-provider.js'
import type { DeviceSnapshot } from '../types.js'
import type { CompanionProvider } from './companion-provider.js'
import type { UiAutomatorDumpProvider } from './uiautomator-provider.js'

/**
 * 主备容错 provider：优先用 Companion，失败自动降级到 uiautomator。
 *
 * 关键约束：tap/setText/scroll 的 ref 基于最近一次 snapshot，因此所有操作
 * 必须走「与最近一次快照相同的 provider」，否则 ref 会错位。
 *
 * 降级后冷却 30 秒内持续走 uiautomator；冷却结束后下次 snapshot 自动尝试
 * 恢复 Companion。source 字段如实反映实际来源。
 */
export class FallbackSnapshotProvider implements SnapshotProvider {
  private current: SnapshotProvider
  private degradedUntil = 0

  constructor(
    private readonly primary: CompanionProvider,
    private readonly fallback: UiAutomatorDumpProvider,
    private readonly options: { degradeCooldownMs?: number } = {},
  ) {
    this.current = primary
  }

  async snapshot(): Promise<DeviceSnapshot> {
    // 冷却期内直接用 uiautomator
    if (Date.now() < this.degradedUntil) {
      this.current = this.fallback
      return this.fallback.snapshot()
    }
    // 尝试 Companion，失败则降级
    try {
      const snap = await this.primary.snapshot()
      this.current = this.primary
      return snap
    } catch {
      this.degradedUntil = Date.now() + (this.options.degradeCooldownMs ?? 30_000)
      this.current = this.fallback
      return this.fallback.snapshot()
    }
  }

  async tapNode(ref: number): Promise<{ ok: boolean; message: string }> {
    return this.current.tapNode(ref)
  }

  async setText(ref: number, text: string): Promise<{ ok: boolean; message: string }> {
    return this.current.setText(ref, text)
  }

  async scrollNode(ref: number, direction: 'forward' | 'backward'): Promise<{ ok: boolean; message: string }> {
    return this.current.scrollNode(ref, direction)
  }
}