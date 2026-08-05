import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mintAdminSession, verifyAdminSession } from '../../src/auth/admin-session'

const ORIG = process.env.ADMIN_SECRET
beforeEach(() => {
  process.env.ADMIN_SECRET = 'sekret-admin'
})
afterEach(() => {
  if (ORIG === undefined) delete process.env.ADMIN_SECRET
  else process.env.ADMIN_SECRET = ORIG
})

describe('admin-session — passkey-unlocked admin token (0009 Phase 2)', () => {
  it('mints a was_ token that verifies', () => {
    const s = mintAdminSession(60_000)!
    expect(s.token.startsWith('was_')).toBe(true)
    expect(verifyAdminSession(s.token)).toBe(true)
  })

  it('rejects an EXPIRED token', () => {
    const s = mintAdminSession(-1_000)! // exp in the past
    expect(verifyAdminSession(s.token)).toBe(false)
  })

  it('rejects a token with a tampered signature', () => {
    const s = mintAdminSession(60_000)!
    const last = s.token.slice(-1)
    const tampered = s.token.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    expect(verifyAdminSession(tampered)).toBe(false)
  })

  it('rejects a token signed under a DIFFERENT secret (rotation invalidates)', () => {
    const s = mintAdminSession(60_000)!
    process.env.ADMIN_SECRET = 'rotated-secret'
    expect(verifyAdminSession(s.token)).toBe(false)
  })

  it('mints null and verifies false when ADMIN_SECRET is unset', () => {
    delete process.env.ADMIN_SECRET
    expect(mintAdminSession()).toBeNull()
    expect(verifyAdminSession('was_eyJ.abc')).toBe(false)
  })

  it('does NOT treat a raw secret / random string as a session', () => {
    expect(verifyAdminSession('sekret-admin')).toBe(false)
    expect(verifyAdminSession('was_')).toBe(false)
  })
})
