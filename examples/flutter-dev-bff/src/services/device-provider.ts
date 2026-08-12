import type { DeviceSnapshot } from '../types.js'

export interface SnapshotProvider {
  snapshot(): Promise<DeviceSnapshot>
  tapNode(ref: number): Promise<{ ok: boolean; message: string }>
  setText(ref: number, text: string): Promise<{ ok: boolean; message: string }>
  scrollNode(ref: number, direction: 'forward' | 'backward'): Promise<{ ok: boolean; message: string }>
}
