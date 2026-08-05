import { Hono } from 'hono'
import { requireAdmin } from '../middleware/require-api-key'
import { webauthn } from '../auth/webauthn'
import { mintAdminSession } from '../auth/admin-session'
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'

// Passkeys / WebAuthn — 0009.
//   register/* + credentials  → OWNER ops, behind ADMIN_SECRET (per-route guard).
//   auth/*                    → PUBLIC by necessity: you authenticate here to
//                               OBTAIN admin access, so it can't require admin.
//                               Still safe — each ceremony needs a server-issued,
//                               single-use challenge + a valid passkey assertion.
// Auth is attached PER ROUTE (not via `use('*', …)`) so the two tiers coexist on
// one router without a wildcard-middleware clash.
export const webauthnRouter = new Hono()

// ── Enrollment (ADMIN_SECRET) ───────────────────────────────────────────────
webauthnRouter.post('/register/options', requireAdmin, async (c) => {
  try {
    return c.json(await webauthn.startRegistration(c))
  } catch (err) {
    return c.json({ error: 'Registration options failed', message: (err as Error).message }, 500)
  }
})

webauthnRouter.post('/register/verify', requireAdmin, async (c) => {
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
    return c.json({ error: 'Registration persist failed', message: (err as Error).message }, 500)
  }
})

webauthnRouter.get('/credentials', requireAdmin, async (c) => {
  try {
    const credentials = await webauthn.listCredentials()
    return c.json({ backend: webauthn.hasRedis ? 'redis' : 'memory', credentials })
  } catch (err) {
    return c.json({ error: 'List failed', message: (err as Error).message }, 500)
  }
})

webauthnRouter.delete('/credentials/:id', requireAdmin, async (c) => {
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

// ── Authentication (PUBLIC → mints a short-lived admin session on success) ──
webauthnRouter.post('/auth/options', async (c) => {
  try {
    return c.json(await webauthn.startAuthentication(c))
  } catch (err) {
    return c.json({ error: 'Auth options failed', message: (err as Error).message }, 500)
  }
})

webauthnRouter.post('/auth/verify', async (c) => {
  let body: { response?: AuthenticationResponseJSON }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body?.response || typeof body.response !== 'object') {
    return c.json({ error: 'Missing "response" (AuthenticationResponseJSON)' }, 400)
  }
  let result
  try {
    result = await webauthn.finishAuthentication(c, body.response)
  } catch (err) {
    return c.json({ error: 'Auth verify failed', message: (err as Error).message }, 500)
  }
  if (!result.verified) {
    return c.json({ verified: false, error: result.error }, 401)
  }
  // Model (a): a verified passkey unlocks a short-lived admin session token that
  // validateAdmin accepts alongside ADMIN_SECRET. ADMIN_SECRET keeps working.
  const session = mintAdminSession()
  if (!session) {
    // ADMIN_SECRET unset → the admin plane is disabled, so no session to mint.
    return c.json({ verified: true, error: 'Admin plane not configured (ADMIN_SECRET unset)' }, 503)
  }
  return c.json({
    verified: true,
    credentialId: result.credentialId,
    token: session.token,
    expiresAt: session.expiresAt,
  })
})
