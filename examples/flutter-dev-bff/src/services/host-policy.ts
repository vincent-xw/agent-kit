export interface HostPolicyService {
  isTrusted(sessionId: string): boolean
  setTrusted(sessionId: string, trusted: boolean): void
}

export function createHostPolicyService(): HostPolicyService {
  const trusted = new Map<string, boolean>()
  return {
    isTrusted(sessionId) { return trusted.get(sessionId) === true },
    setTrusted(sessionId, v) { trusted.set(sessionId, v) },
  }
}