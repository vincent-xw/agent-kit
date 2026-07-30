import { describe, expect, it } from 'vitest'

import { AGENT_KIT_VERSION } from './index.js'

describe('core package', () => {
  it('暴露运行时版本', () => {
    expect(AGENT_KIT_VERSION).toBe('0.1.0')
  })
})
