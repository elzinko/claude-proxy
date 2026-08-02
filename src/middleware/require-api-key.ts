import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'

function getAllowedKeys(): string[] {
  return process.env.API_KEY?.split(',').map((k) => k.trim()).filter(Boolean) || []
}

function extractBearer(c: Context): string | undefined {
  const header = c.req.header('authorization')
  if (!header) return undefined
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return undefined
  return value
}

// Constant-time string comparison to avoid leaking key/secret length or content
// via response timing. Returns false on length mismatch (timingSafeEqual throws
// on unequal-length buffers).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function isApiKeyConfigured(): boolean {
  return getAllowedKeys().length > 0
}

export function validateApiKey(c: Context): { ok: true; key: string } | { ok: false; status: 401 | 500; body: Record<string, unknown> } {
  const allowedKeys = getAllowedKeys()

  // TL2 (0008): fail CLOSED on EVERY platform when no key is configured.
  // Previously this returned `ok: true` (open relay) outside Vercel/production,
  // which turned any self-hosted / misconfigured deploy into an unauthenticated
  // proxy in front of the paid Claude subscription. Never serve without a key.
  if (allowedKeys.length === 0) {
    console.error('⚠️  SECURITY: API_KEY is not configured — refusing all requests (fail-closed).')
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Configuration error',
        message: 'server misconfigured: no API_KEY configured',
      },
    }
  }

  const providedKey = extractBearer(c)
  if (!providedKey || !allowedKeys.some((k) => safeEqual(k, providedKey))) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Authentication required',
        message: 'Please provide a valid API key',
      },
    }
  }

  return { ok: true, key: providedKey }
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const result = validateApiKey(c)
  if (!result.ok) {
    return c.json(result.body, result.status)
  }
  c.set('apiKey', result.key)
  await next()
}

// ── Admin plane (0008 TL1) ──────────────────────────────────────────────
// Privileged, owner-only operations (destructive auth mutations, and — once
// per-app keys land — client revocation) must sit behind a secret that is
// DISTINCT from client API keys. Fail CLOSED: if ADMIN_SECRET is unset, no
// admin route is reachable at all.
export function validateAdmin(c: Context): { ok: true } | { ok: false; status: 401 | 500; body: Record<string, unknown> } {
  const secret = process.env.ADMIN_SECRET?.trim()
  if (!secret) {
    console.error('⚠️  SECURITY: ADMIN_SECRET is not configured — admin routes are fail-closed (denied).')
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Configuration error',
        message: 'server misconfigured: ADMIN_SECRET not set',
      },
    }
  }
  const provided = extractBearer(c)
  if (!provided || !safeEqual(secret, provided)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Admin authentication required',
        message: 'This operation requires the admin secret',
      },
    }
  }
  return { ok: true }
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const result = validateAdmin(c)
  if (!result.ok) {
    return c.json(result.body, result.status)
  }
  await next()
}
