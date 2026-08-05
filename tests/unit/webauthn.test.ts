import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webauthnRouter } from '../../src/routes/webauthn'

// Compose the router as server.ts mounts it, drive it with app.request().
// These cover the parts testable without a browser/authenticator: the admin
// gating, the options ceremony (server-issued challenge + RP-ID), and the
// reject paths. The cryptographic attestation verification needs a real passkey
// and is validated end-to-end in a browser.
function makeApp() {
  const app = new Hono()
  app.route('/auth/webauthn', webauthnRouter)
  return app
}

const ORIG = { ADMIN_SECRET: process.env.ADMIN_SECRET, UURL: process.env.UPSTASH_REDIS_REST_URL }
const ADMIN = 'admin-secret'

beforeEach(() => {
  process.env.ADMIN_SECRET = ADMIN
  delete process.env.UPSTASH_REDIS_REST_URL // force in-memory fallback
})
afterEach(() => {
  process.env.ADMIN_SECRET = ORIG.ADMIN_SECRET
  if (ORIG.UURL) process.env.UPSTASH_REDIS_REST_URL = ORIG.UURL
})

function admin(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${ADMIN}` },
  }
}
function postJson(token: string | null, body: unknown): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

describe('WebAuthn enrollment router (0009 Phase 1) — ADMIN_SECRET gating', () => {
  it('rejects register/options with no credentials (401)', async () => {
    const res = await makeApp().request('/auth/webauthn/register/options', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects register/options with a wrong secret (401)', async () => {
    const res = await makeApp().request('/auth/webauthn/register/options', postJson('nope', {}))
    expect(res.status).toBe(401)
  })

  it('rejects GET /credentials without admin (401)', async () => {
    const res = await makeApp().request('/auth/webauthn/credentials', {})
    expect(res.status).toBe(401)
  })
})

describe('WebAuthn enrollment router — ceremony + reject paths', () => {
  it('register/options returns creation options with a server challenge + RP-ID', async () => {
    const res = await makeApp().request('/auth/webauthn/register/options', admin({ method: 'POST' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { challenge?: string; rp?: { id?: string }; user?: unknown }
    expect(typeof body.challenge).toBe('string')
    expect((body.challenge as string).length).toBeGreaterThan(10)
    expect(body.rp?.id).toBe('localhost') // derived from the request host
    expect(body.user).toBeTruthy()
  })

  it('GET /credentials returns an (initially empty) list under admin', async () => {
    const res = await makeApp().request('/auth/webauthn/credentials', admin())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { backend: string; credentials: unknown[] }
    expect(Array.isArray(body.credentials)).toBe(true)
    expect(body.backend).toBe('memory')
  })

  it('register/verify with a missing response body → 400', async () => {
    const res = await makeApp().request('/auth/webauthn/register/verify', postJson(ADMIN, { label: 'x' }))
    expect(res.status).toBe(400)
  })

  it('register/verify with a bogus attestation → 400 (not verified)', async () => {
    const res = await makeApp().request(
      '/auth/webauthn/register/verify',
      postJson(ADMIN, { response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} }, label: 'x' }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { verified: boolean }
    expect(body.verified).toBe(false)
  })

  it('DELETE /credentials/:id for an unknown id → 404', async () => {
    const res = await makeApp().request('/auth/webauthn/credentials/does-not-exist', admin({ method: 'DELETE' }))
    expect(res.status).toBe(404)
  })
})
