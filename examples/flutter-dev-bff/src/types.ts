export interface DeviceInfo {
  serial: string
  state: 'device' | 'offline' | 'unauthorized'
  model?: string
  product?: string
}

export interface DeviceNode {
  ref: number
  nodeId: string
  text?: string
  contentDescription?: string
  className?: string
  resourceId?: string
  bounds: { left: number; top: number; right: number; bottom: number }
  clickable: boolean
  scrollable: boolean
  editable: boolean
  enabled: boolean
  checked?: boolean
  focused: boolean
  selected?: boolean
}

export interface DeviceSnapshot {
  snapshotId: string
  packageName: string
  windowTitle?: string
  screenWidth: number
  screenHeight: number
  nodes: DeviceNode[]
  truncated?: number
}

export interface FlutterLogEntry {
  timestamp: number
  level: 'stdout' | 'stderr'
  text: string
}

export interface FlutterRunInfo {
  processId: number
  vmServiceUri: string
  deviceSerial: string
  startedAt: number
}

export interface AnalyzeIssue {
  severity: 'error' | 'warning' | 'info'
  file: string
  line: number
  column?: number
  message: string
  code?: string
}

export interface TestFailure {
  testName: string
  file?: string
  line?: number
  error: string
}

export interface TestResult {
  passed: boolean
  total: number
  passedCount: number
  failedCount: number
  durationMs: number
  failures: TestFailure[]
}

export interface ScreenshotInfo {
  id: string
  path: string
  width: number
  height: number
  takenAt: number
}

export type AndroidKey =
  | 'back'
  | 'home'
  | 'menu'
  | 'enter'
  | 'volume_up'
  | 'volume_down'
  | 'power'
  | 'app_switch'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'search'
