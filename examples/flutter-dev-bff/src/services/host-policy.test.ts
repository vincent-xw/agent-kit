import { describe, it, expect } from 'vitest'
import { createHostPolicyService } from './host-policy.js'

describe('HostPolicy', () => {
  it('默认关、按会话隔离', () => {
    const p = createHostPolicyService()
    expect(p.isTrusted('flutter-dev:s1')).toBe(false)
    p.setTrusted('flutter-dev:s1', true)
    expect(p.isTrusted('flutter-dev:s1')).toBe(true)
    expect(p.isTrusted('flutter-dev:s2')).toBe(false)
  })
  it('可关闭', () => {
    const p = createHostPolicyService()
    p.setTrusted('flutter-dev:s1', true)
    p.setTrusted('flutter-dev:s1', false)
    expect(p.isTrusted('flutter-dev:s1')).toBe(false)
  })
})