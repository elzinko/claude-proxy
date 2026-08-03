import { Hono } from 'hono'
import { requireAdmin } from '../middleware/require-api-key'
import { registry } from '../middleware/key-registry'

// Per-app API-key admin plane (0006). ADMIN_SECRET tier ONLY — never
// requireApiKey: minting/revoking keys is an owner operation and must not be
// reachable with a client key.
export const keysRouter = new Hono()

keysRouter.use('*', requireAdmin)

const KEY_ID_RE = /^[0-9a-f]{12}$/

// POST /api/keys — mint a new per-app key.
// MF5: the plaintext key is returned ONLY here, at mint time; it is never
// persisted in plaintext and never re-exposed by GET.
keysRouter.post('/', async (c) => {
  let label = ''
  try {
    const body = (await c.req.json()) as { label?: unknown }
    label = typeof body?.label === 'string' ? body.label.trim() : ''
  } catch {
    label = ''
  }
  if (!label || label.length > 100) {
    return c.json(
      { error: 'Invalid label', message: 'A non-empty "label" (max 100 chars) is required' },
      400,
    )
  }
  try {
    const minted = await registry.mint(label)
    return c.json(minted, 201)
  } catch (err) {
    return c.json(
      { error: 'Mint failed', message: (err as Error).message },
      500,
    )
  }
})

// GET /api/keys — list keys (metadata only; NEVER secretHash or plaintext).
keysRouter.get('/', async (c) => {
  try {
    const keys = await registry.listKeys()
    return c.json({ backend: registry.hasRedis ? 'redis' : 'memory', keys })
  } catch (err) {
    return c.json(
      { error: 'List failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /api/keys/revoke-all — global downstream kill (0004): revoke EVERY
// per-app key at once. Static path, so it never collides with /:keyId/revoke
// (that route needs two segments). Idempotent; returns the count newly revoked.
keysRouter.post('/revoke-all', async (c) => {
  try {
    const revoked = await registry.revokeAll()
    return c.json({ revoked })
  } catch (err) {
    return c.json(
      { error: 'Revoke-all failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /api/keys/:keyId/revoke — idempotent revoke by key-id.
keysRouter.post('/:keyId/revoke', async (c) => {
  const keyId = c.req.param('keyId')
  if (!KEY_ID_RE.test(keyId)) {
    return c.json({ error: 'Invalid keyId', message: 'malformed key id' }, 400)
  }
  try {
    const res = await registry.getKey(keyId)
    if ('error' in res) {
      return c.json(
        { error: 'Registry error', message: 'key registry unavailable' },
        500,
      )
    }
    if (!res.found) {
      return c.json({ error: 'Unknown key', message: 'no such key id' }, 404)
    }
    await registry.revokeKey(keyId)
    return c.json({ revoked: true, keyId })
  } catch (err) {
    return c.json(
      { error: 'Revoke failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /api/keys/:keyId/unrevoke — symmetric.
keysRouter.post('/:keyId/unrevoke', async (c) => {
  const keyId = c.req.param('keyId')
  if (!KEY_ID_RE.test(keyId)) {
    return c.json({ error: 'Invalid keyId', message: 'malformed key id' }, 400)
  }
  try {
    const res = await registry.getKey(keyId)
    if ('error' in res) {
      return c.json(
        { error: 'Registry error', message: 'key registry unavailable' },
        500,
      )
    }
    if (!res.found) {
      return c.json({ error: 'Unknown key', message: 'no such key id' }, 404)
    }
    await registry.unrevokeKey(keyId)
    return c.json({ revoked: false, keyId })
  } catch (err) {
    return c.json(
      { error: 'Unrevoke failed', message: (err as Error).message },
      500,
    )
  }
})
