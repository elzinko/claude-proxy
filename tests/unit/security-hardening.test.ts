import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'hono'
import {
  validateAdmin,
  validateApiKey,
} from '../../src/middleware/require-api-key'
import { registry } from '../../src/middleware/key-registry'

// Minimal fake Hono Context: only `req.header('authorization')` is read.
function ctx(authHeader?: string): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authHeader : undefined,
    },
    // validateApiKey never calls c.set() (that's requireApiKey's job), but keep
    // a no-op so an accidental call doesn't throw.
    set: () => {},
  } as unknown as Context
}

const ORIG = {
  API_KEY: process.env.API_KEY,
  ADMIN_SECRET: process.env.ADMIN_SECRET,
  LEGACY_KEY_DISABLED: process.env.LEGACY_KEY_DISABLED,
}

beforeEach(() => {
  delete process.env.API_KEY
  delete process.env.ADMIN_SECRET
  delete process.env.LEGACY_KEY_DISABLED
})
afterEach(() => {
  process.env.API_KEY = ORIG.API_KEY
  process.env.ADMIN_SECRET = ORIG.ADMIN_SECRET
  process.env.LEGACY_KEY_DISABLED = ORIG.LEGACY_KEY_DISABLED
})

describe('validateApiKey — fail-closed gate + legacy branch', () => {
  it('DENIES when no API_KEY and no registry backend (fail-closed)', async () => {
    // In-memory tests have registry.hasRedis === false, so the widened gate
    // hard-500s. (If a dev exported UPSTASH_*, the gate defers and a bad legacy
    // key 401s instead — both are "denied", never "ok".)
    const r = await validateApiKey(ctx('Bearer anything'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(registry.hasRedis ? 401 : 500)
  })

  it('DENIES with no key even when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'development'
    const r = await validateApiKey(ctx('Bearer anything'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(registry.hasRedis ? 401 : 500)
    delete process.env.NODE_ENV
  })

  it('accepts a valid legacy env key (keyId env:legacy)', async () => {
    process.env.API_KEY = 'k1,k2'
    const r = await validateApiKey(ctx('Bearer k2'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.key).toBe('k2')
      expect(r.keyId).toBe('env:legacy')
      expect(r.label).toBe('env:legacy')
    }
  })

  it('rejects a wrong legacy key (401)', async () => {
    process.env.API_KEY = 'k1'
    const r = await validateApiKey(ctx('Bearer nope'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects a missing Authorization header (401)', async () => {
    process.env.API_KEY = 'k1'
    const r = await validateApiKey(ctx(undefined))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('LEGACY_KEY_DISABLED=1 makes a valid legacy key 401', async () => {
    process.env.API_KEY = 'k1'
    process.env.LEGACY_KEY_DISABLED = '1'
    const r = await validateApiKey(ctx('Bearer k1'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('401 body carries an actionable hint pointing to /api/keys (0002)', async () => {
    process.env.API_KEY = 'k1'
    const r = await validateApiKey(ctx('Bearer nope'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(401)
      expect(typeof r.body.hint).toBe('string')
      expect(String(r.body.hint)).toContain('/api/keys')
    }
  })
})

describe('validateApiKey — registry (cxk_) branch', () => {
  // A non-empty API_KEY is set so the sync gate passes; the cxk_ branch then
  // validates purely against the registry and NEVER falls back to the env key.
  beforeEach(() => {
    process.env.API_KEY = 'legacy-present'
  })

  it('accepts a valid minted cxk_ key and returns its keyId + label', async () => {
    const minted = await registry.mint('app-valid')
    const r = await validateApiKey(ctx(`Bearer ${minted.key}`))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.key).toBe(minted.key)
      expect(r.keyId).toBe(minted.keyId)
      expect(r.label).toBe('app-valid')
    }
  })

  it('rejects a REVOKED cxk_ key (401), independent of IP', async () => {
    const minted = await registry.mint('app-revoked')
    await registry.revokeKey(minted.keyId)
    const r = await validateApiKey(ctx(`Bearer ${minted.key}`))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects a malformed cxk_ key (401)', async () => {
    // no second underscore
    let r = await validateApiKey(ctx('Bearer cxk_deadbeefcafe'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)

    // keyId not 12-hex
    r = await validateApiKey(ctx('Bearer cxk_NOTHEX_secretpart'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)

    // empty secret
    r = await validateApiKey(ctx('Bearer cxk_deadbeefcafe_'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects an UNKNOWN cxk_ key (401) with NO legacy fallback', async () => {
    // Well-formed keyId that was never minted; must 401 even though a valid
    // legacy API_KEY is configured — the branches never cross over.
    const r = await validateApiKey(ctx('Bearer cxk_a1b2c3d4e5f6_someRandomSecret_-'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects a cxk_ key with a wrong secret for a real keyId (401)', async () => {
    const minted = await registry.mint('app-wrongsecret')
    const forged = `cxk_${minted.keyId}_thisisnottherightsecret`
    const r = await validateApiKey(ctx(`Bearer ${forged}`))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  // Kept LAST in this block: revokeAll() disables EVERY registry key, so any
  // later cxk_ test would otherwise start from an all-revoked registry.
  it('revokeAll() kills every key — global downstream revoke (0004)', async () => {
    const a = await registry.mint('kill-a')
    const b = await registry.mint('kill-b')
    expect((await validateApiKey(ctx(`Bearer ${a.key}`))).ok).toBe(true)

    const n = await registry.revokeAll()
    expect(n).toBeGreaterThanOrEqual(2)

    for (const k of [a.key, b.key]) {
      const r = await validateApiKey(ctx(`Bearer ${k}`))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(401)
    }
  })
})

describe('validateAdmin — TL1 admin plane, fail-closed', () => {
  it('DENIES (500) when ADMIN_SECRET is unset', () => {
    const r = validateAdmin(ctx('Bearer whatever'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(500)
  })

  it('accepts the correct admin secret', () => {
    process.env.ADMIN_SECRET = 's3cr3t'
    const r = validateAdmin(ctx('Bearer s3cr3t'))
    expect(r.ok).toBe(true)
  })

  it('rejects a wrong secret (401)', () => {
    process.env.ADMIN_SECRET = 's3cr3t'
    const r = validateAdmin(ctx('Bearer wrong'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('does NOT accept a client API key as the admin secret', () => {
    process.env.API_KEY = 'client-key'
    process.env.ADMIN_SECRET = 'admin-key'
    const r = validateAdmin(ctx('Bearer client-key'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })
})
