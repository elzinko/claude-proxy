import { Hono } from 'hono'
import { requireAdmin } from '../middleware/require-api-key'
import { webauthn } from '../auth/webauthn'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'

// Passkeys / WebAuthn — 0009 Phase 1 (enrollment). Registration + credential
// management are OWNER operations → the whole router is behind ADMIN_SECRET.
// (The authentication ceremony that *unlocks* the admin plane is Phase 2 and
// will be mounted separately, partly public by necessity.)
export const webauthnRouter = new Hono()

webauthnRouter.use('*', requireAdmin)

// POST /auth/webauthn/register/options — begin enrollment: returns the WebAuthn
// creation options (with a server-issued challenge stored single-use, TTL 5m).
webauthnRouter.post('/register/options', async (c) => {
  try {
    const options = await webauthn.startRegistration(c)
    return c.json(options)
  } catch (err) {
    return c.json(
      { error: 'Registration options failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /auth/webauthn/register/verify — finish enrollment: verify the
// attestation against the stored challenge + expected origin/RP-ID, persist the
// PUBLIC credential. Body: { response: RegistrationResponseJSON, label?: string }.
webauthnRouter.post('/register/verify', async (c) => {
  let body: { response?: RegistrationResponseJSON; label?: string }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body?.response || typeof body.response !== 'object') {
    return c.json({ error: 'Missing "response" (RegistrationResponseJSON)' }, 400)
  }
  const label = typeof body.label === 'string' ? body.label : 'passkey'
  try {
    const result = await webauthn.finishRegistration(c, body.response, label)
    if (!result.verified) {
      return c.json({ verified: false, error: result.error }, 400)
    }
    return c.json({ verified: true, credentialId: result.credentialId }, 201)
  } catch (err) {
    // e.g. the credential verified but persisting it failed — a server error,
    // distinct from a failed attestation (which returns a structured 400 above).
    return c.json({ error: 'Registration persist failed', message: (err as Error).message }, 500)
  }
})

// GET /auth/webauthn/credentials — list enrolled passkeys (metadata only; the
// private key never leaves the authenticator, so there is nothing secret here).
webauthnRouter.get('/credentials', async (c) => {
  try {
    const credentials = await webauthn.listCredentials()
    return c.json({ backend: webauthn.hasRedis ? 'redis' : 'memory', credentials })
  } catch (err) {
    return c.json({ error: 'List failed', message: (err as Error).message }, 500)
  }
})

// DELETE /auth/webauthn/credentials/:id — remove an enrolled passkey.
webauthnRouter.delete('/credentials/:id', async (c) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Missing credential id' }, 400)
  try {
    const removed = await webauthn.deleteCredential(id)
    if (!removed) return c.json({ error: 'Unknown credential id' }, 404)
    return c.json({ deleted: true, id })
  } catch (err) {
    return c.json({ error: 'Delete failed', message: (err as Error).message }, 500)
  }
})
