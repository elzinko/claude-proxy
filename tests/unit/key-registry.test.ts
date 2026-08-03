import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { registry } from '../../src/middleware/key-registry'

// These tests exercise the IN-MEMORY path (no UPSTASH_* env → registry falls
// back to a Map). vitest does not load .env, so this is the default surface.

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Parse a `cxk_<keyId>_<secret>` key the SAME way require-api-key does:
// slice off the prefix, split on the FIRST underscore only. Never split('_'),
// because the base64url secret legitimately contains '_' and '-'.
function parseKey(key: string): { keyId: string; secret: string } {
  const rest = key.slice(4)
  const i = rest.indexOf('_')
  return { keyId: rest.slice(0, i), secret: rest.slice(i + 1) }
}

describe('key-registry — mint', () => {
  it('mints a cxk_ key with a 12-hex keyId and a base64url secret', async () => {
    const { key, keyId, label, created } = await registry.mint('app-alpha')
    expect(key.startsWith('cxk_')).toBe(true)
    expect(keyId).toMatch(/^[0-9a-f]{12}$/)
    expect(label).toBe('app-alpha')
    expect(typeof created).toBe('string')
    expect(Number.isNaN(Date.parse(created))).toBe(false)

    const parsed = parseKey(key)
    expect(parsed.keyId).toBe(keyId)
    // base64url alphabet only (A–Z a–z 0–9 - _), no padding
    expect(parsed.secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('stores secretHash = sha256(secret) hex, never the secret itself', async () => {
    const { key, keyId } = await registry.mint('app-hash')
    const { secret } = parseKey(key)

    const res = await registry.getKey(keyId)
    expect('found' in res && res.found).toBe(true)
    if ('record' in res) {
      expect(res.record.secretHash).toBe(sha256Hex(secret))
      // The raw secret must never be persisted anywhere on the record.
      expect(JSON.stringify(res.record)).not.toContain(secret)
      expect(res.record.status).toBe('active')
    }
  })

  it('round-trips a secret that contains base64url "_" and "-"', async () => {
    // Mint until we get a secret with at least one '_' or '-' (base64url makes
    // this overwhelmingly likely; loop to keep it deterministic).
    let picked: { key: string; keyId: string } | null = null
    for (let i = 0; i < 100 && !picked; i++) {
      const m = await registry.mint(`app-b64-${i}`)
      const { secret } = parseKey(m.key)
      if (secret.includes('_') || secret.includes('-')) {
        picked = { key: m.key, keyId: m.keyId }
      }
    }
    expect(picked).not.toBeNull()

    const { key, keyId } = picked!
    const { keyId: parsedId, secret } = parseKey(key)
    // Parsing on the FIRST underscore recovers the full keyId + full secret,
    // even though the secret itself contains underscores/dashes.
    expect(parsedId).toBe(keyId)
    const res = await registry.getKey(keyId)
    if ('record' in res && res.found) {
      expect(res.record.secretHash).toBe(sha256Hex(secret))
    }
  })
})

describe('key-registry — getKey (discriminated, fail-closed)', () => {
  it('returns {found:false} for an unknown key id', async () => {
    const res = await registry.getKey('ffffffffffff')
    expect(res).toEqual({ found: false })
  })

  it('returns {found:true, record} for a minted key', async () => {
    const { keyId, label } = await registry.mint('app-get')
    const res = await registry.getKey(keyId)
    expect('found' in res && res.found).toBe(true)
    if ('record' in res && res.found) {
      expect(res.record.keyId).toBe(keyId)
      expect(res.record.label).toBe(label)
    }
  })
})

describe('key-registry — revoke / unrevoke', () => {
  it('flips status to revoked and back to active by key-id', async () => {
    const { keyId } = await registry.mint('app-revoke')

    expect(await registry.revokeKey(keyId)).toBe(true)
    let res = await registry.getKey(keyId)
    if ('record' in res && res.found) expect(res.record.status).toBe('revoked')

    expect(await registry.unrevokeKey(keyId)).toBe(true)
    res = await registry.getKey(keyId)
    if ('record' in res && res.found) expect(res.record.status).toBe('active')
  })

  it('revoke is idempotent and returns false for an unknown key-id', async () => {
    const { keyId } = await registry.mint('app-idem')
    expect(await registry.revokeKey(keyId)).toBe(true)
    expect(await registry.revokeKey(keyId)).toBe(true) // idempotent
    expect(await registry.revokeKey('ffffffffffff')).toBe(false)
  })
})

describe('key-registry — listKeys / hasAnyKey', () => {
  it('lists metadata only (no secretHash, no plaintext) and reports keys exist', async () => {
    const { keyId, key } = await registry.mint('app-list')
    const { secret } = parseKey(key)

    expect(await registry.hasAnyKey()).toBe(true)

    const list = await registry.listKeys()
    const item = list.find((k) => k.keyId === keyId)
    expect(item).toBeDefined()
    expect(item).toMatchObject({ keyId, label: 'app-list', status: 'active' })
    // Listing must never expose secret material.
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('secretHash')
    expect(serialized).not.toContain(secret)
  })
})
