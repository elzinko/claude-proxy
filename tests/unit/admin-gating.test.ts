import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keysRouter } from '../../src/routes/keys'
import { clientsRouter } from '../../src/routes/clients'
import { statsRouter } from '../../src/routes/stats'
import { statusRouter } from '../../src/routes/status'

// Compose the routers exactly as server.ts mounts them, then drive them with
// app.request(). Auth tiers are enforced by middleware, so these assert the
// GATING (who is allowed), not the business logic behind it.
function makeApp() {
  const app = new Hono()
  app.route('/api/keys', keysRouter)
  app.route('/api/clients', clientsRouter)
  app.route('/api/stats', statsRouter)
  app.route('/api/status', statusRouter)
  return app
}

const ORIG = {
  API_KEY: process.env.API_KEY,
  ADMIN_SECRET: process.env.ADMIN_SECRET,
  LEGACY_KEY_DISABLED: process.env.LEGACY_KEY_DISABLED,
}

const CLIENT_KEY = 'client-key'
const ADMIN_SECRET = 'admin-secret'

beforeEach(() => {
  process.env.API_KEY = CLIENT_KEY
  process.env.ADMIN_SECRET = ADMIN_SECRET
  delete process.env.LEGACY_KEY_DISABLED
})
afterEach(() => {
  process.env.API_KEY = ORIG.API_KEY
  process.env.ADMIN_SECRET = ORIG.ADMIN_SECRET
  process.env.LEGACY_KEY_DISABLED = ORIG.LEGACY_KEY_DISABLED
})

function bearer(token?: string): RequestInit {
  return token ? { headers: { authorization: `Bearer ${token}` } } : {}
}

function postJson(token: string | undefined, body: unknown): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

describe('/api/keys — ADMIN_SECRET only (never a client key)', () => {
  it('rejects mint with no credentials (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects mint with a valid CLIENT key (401 — not admin)', async () => {
    const app = makeApp()
    const res = await app.request('/api/keys', postJson(CLIENT_KEY, { label: 'x' }))
    expect(res.status).toBe(401)
  })

  it('rejects list with a valid CLIENT key (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/keys', bearer(CLIENT_KEY))
    expect(res.status).toBe(401)
  })

  it('allows mint with the admin secret (201 + plaintext key returned once)', async () => {
    const app = makeApp()
    const res = await app.request('/api/keys', postJson(ADMIN_SECRET, { label: 'app-mint' }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { key: string; keyId: string; label: string }
    expect(body.key.startsWith('cxk_')).toBe(true)
    expect(body.keyId).toMatch(/^[0-9a-f]{12}$/)
    expect(body.label).toBe('app-mint')
  })

  it('rejects mint with an empty label (400) under admin', async () => {
    const app = makeApp()
    const res = await app.request('/api/keys', postJson(ADMIN_SECRET, { label: '  ' }))
    expect(res.status).toBe(400)
  })
})

describe('/api/clients — ADMIN_SECRET only (reads + mutations) — TL5 (0008)', () => {
  // The reads (list, daily) expose every tracked client's IP / ASN / usage, so
  // a client key must NOT see them — the whole router is admin-gated now.
  it('rejects GET / with a valid CLIENT key (401 — reads are admin now)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients', bearer(CLIENT_KEY))
    expect(res.status).toBe(401)
  })

  it('allows GET / with the admin secret (200)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients', bearer(ADMIN_SECRET))
    expect(res.status).toBe(200)
  })

  it('rejects GET /daily with a valid CLIENT key (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients/daily', bearer(CLIENT_KEY))
    expect(res.status).toBe(401)
  })

  it('rejects GET / with no credentials (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients', {})
    expect(res.status).toBe(401)
  })

  it('rejects POST /:fp/revoke with a CLIENT key (401 — mutation is admin)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients/abcdef0123456789/revoke', postJson(CLIENT_KEY, {}))
    expect(res.status).toBe(401)
  })

  it('rejects POST /:fp/revoke with no credentials (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients/abcdef0123456789/revoke', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('allows POST /:fp/revoke with the admin secret (200)', async () => {
    const app = makeApp()
    const res = await app.request('/api/clients/abcdef0123456789/revoke', postJson(ADMIN_SECRET, {}))
    expect(res.status).toBe(200)
  })
})

describe('/api/stats + /api/status/full — ADMIN_SECRET only — TL5 (0008)', () => {
  // Both aggregate cross-project usage; a client key leaked one app's traffic
  // (and token metadata via /status/full) to every other key holder.
  it('rejects GET /api/stats with a CLIENT key (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/stats', bearer(CLIENT_KEY))
    expect(res.status).toBe(401)
  })

  it('allows GET /api/stats with the admin secret (200)', async () => {
    const app = makeApp()
    const res = await app.request('/api/stats', bearer(ADMIN_SECRET))
    expect(res.status).toBe(200)
  })

  it('rejects GET /api/status/full with a CLIENT key (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/status/full', bearer(CLIENT_KEY))
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/stats with no credentials (401)', async () => {
    const app = makeApp()
    const res = await app.request('/api/stats', {})
    expect(res.status).toBe(401)
  })
})
