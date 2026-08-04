import { defineWorkspace } from 'vitest/config'

/** 将四个 workspace 包各自作为 vitest 项目运行，保证每个包独立收集与执行测试。 */
export default defineWorkspace([
  'packages/*',
])
