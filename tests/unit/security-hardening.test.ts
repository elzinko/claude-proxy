import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'hono'
import { validateAdmin, validateApiKey } from '../../src/middleware/require-api-key'

// Minimal fake Hono Context: only `req.header('authorization')` is read.
function ctx(authHeader?: string): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authHeader : undefined,
    },
  } as unknown as Context
}

const ORIG = { API_KEY: process.env.API_KEY, ADMIN_SECRET: process.env.ADMIN_SECRET }

beforeEach(() => {
  delete process.env.API_KEY
  delete process.env.ADMIN_SECRET
})
afterEach(() => {
  process.env.API_KEY = ORIG.API_KEY
  process.env.ADMIN_SECRET = ORIG.ADMIN_SECRET
})

describe('validateApiKey — TL2 fail-closed', () => {
  it('DENIES (500) when no API_KEY is configured, on every platform', () => {
    const r = validateApiKey(ctx('Bearer anything'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(500)
  })

  it('DENIES (500) with no key even when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development'
    const r = validateApiKey(ctx('Bearer anything'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(500)
    delete process.env.NODE_ENV
  })

  it('accepts a valid key', () => {
    process.env.API_KEY = 'k1,k2'
    const r = validateApiKey(ctx('Bearer k2'))
    expect(r.ok).toBe(true)
  })

  it('rejects a wrong key (401)', () => {
    process.env.API_KEY = 'k1'
    const r = validateApiKey(ctx('Bearer nope'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects a missing Authorization header (401)', () => {
    process.env.API_KEY = 'k1'
    const r = validateApiKey(ctx(undefined))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
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
