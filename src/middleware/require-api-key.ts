import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { registry } from './key-registry'
import { verifyAdminSession } from '../auth/admin-session'

function getAllowedKeys(): string[] {
  return process.env.API_KEY?.split(',').map((k) => k.trim()).filter(Boolean) || []
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Reserved prefix for per-app registry keys: `cxk_<keyId>_<secret>`. A legacy
// env API_KEY that itself starts with this prefix would be routed to the
// registry branch and could never authenticate as a legacy key — warn loudly
// at module load so the operator renames it before it silently locks a client
// out. (Fail-loud config guard, not a request-time check.)
if (getAllowedKeys().some((k) => k.startsWith('cxk_'))) {
  console.error(
    '⚠️  SECURITY: an API_KEY entry begins with the reserved "cxk_" prefix — it ' +
      'will be format-routed to the per-app key registry, never matched as a ' +
      'legacy key. Rename that env key.',
  )
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

// Sync view: env API_KEY only. Kept for callers with no async context.
export function isApiKeyConfigured(): boolean {
  return getAllowedKeys().length > 0
}

// Authoritative view: configured if an env API_KEY is set OR the registry
// actually holds at least one minted key (HLEN>0 — real keys, never bare
// hasRedis). Async because the registry check may hit Redis.
export async function isApiKeyConfiguredAsync(): Promise<boolean> {
  if (getAllowedKeys().length > 0) return true
  return registry.hasAnyKey()
}

type ValidateOk = { ok: true; key: string; keyId: string; label: string }
type ValidateErr = { ok: false; status: 401 | 500; body: Record<string, unknown> }

// 0002: an explicit, actionable 401 — any project that hits the proxy without a
// valid key learns, from the response itself, how to get one. Naming the mint
// endpoint is not a leak: it is admin-gated (ADMIN_SECRET), so a client can only
// obtain a key from the proxy owner, never mint one itself.
function unauthorized(): ValidateErr {
  return {
    ok: false,
    status: 401,
    body: {
      error: 'Authentication required',
      message: 'Missing or invalid credentials — send `Authorization: Bearer <key>`.',
      hint:
        'No key yet? Ask the proxy owner to mint you a per-app key: ' +
        'POST /api/keys {"label":"<your-app>"} with `Authorization: Bearer <ADMIN_SECRET>` ' +
        '(the key is shown once). A legacy env API_KEY also works. See the README.',
    },
  }
}

// Format-routing (0006): a `cxk_`-prefixed bearer is a per-app registry key,
// validated by key-id against the registry; anything else is a legacy env
// API_KEY. The two never fall back onto each other — a bad registry key does
// NOT get a second chance against the env key list.
export async function validateApiKey(c: Context): Promise<ValidateOk | ValidateErr> {
  const allowedKeys = getAllowedKeys()

  // TL2 (0008) fail-closed gate, WIDENED for the registry (0006): only hard-500
  // when there is NO possible authentication source at all — no env API_KEY AND
  // no Redis behind the registry. With Redis present we can't cheaply know
  // synchronously whether the registry holds keys, so we defer to the per-key
  // check below rather than 500 a correctly-configured deploy.
  if (allowedKeys.length === 0 && !registry.hasRedis) {
    console.error(
      '⚠️  SECURITY: no API_KEY configured and no key-registry backend — refusing all requests (fail-closed).',
    )
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Configuration error',
        message: 'server misconfigured: no API_KEY configured',
        hint:
          'Owner: set API_KEY in the environment, OR configure Upstash Redis and ' +
          'mint a per-app key via POST /api/keys (Bearer ADMIN_SECRET). See the README.',
      },
    }
  }

  const providedKey = extractBearer(c)
  if (!providedKey) return unauthorized()

  // ── Registry branch: cxk_<keyId>_<secret> ──────────────────────────────
  if (providedKey.startsWith('cxk_')) {
    const rest = providedKey.slice(4)
    // NEVER split('_'): the base64url secret legitimately contains '_' and '-'.
    // Split on the FIRST '_' only — everything after it is the secret.
    const i = rest.indexOf('_')
    if (i <= 0) return unauthorized()
    const keyId = rest.slice(0, i)
    const secret = rest.slice(i + 1)
    if (!/^[0-9a-f]{12}$/.test(keyId) || !secret) return unauthorized()

    const res = await registry.getKey(keyId)
    if ('error' in res) return unauthorized() // fail-closed, NO legacy fallback
    if (!res.found) return unauthorized()
    const record = res.record
    if (record.status !== 'active') return unauthorized() // revoked, IP-independent
    if (!safeEqual(sha256Hex(secret), record.secretHash)) return unauthorized()

    // Telemetry only — must not block or deny (do NOT await).
    registry.touchLastUsed(keyId)
    return { ok: true, key: providedKey, keyId, label: record.label }
  }

  // ── Legacy branch: env API_KEY (comma-separated) ───────────────────────
  if (process.env.LEGACY_KEY_DISABLED === '1') return unauthorized()
  if (allowedKeys.some((k) => safeEqual(k, providedKey))) {
    return { ok: true, key: providedKey, keyId: 'env:legacy', label: 'env:legacy' }
  }
  return unauthorized()
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const result = await validateApiKey(c)
  if (!result.ok) {
    return c.json(result.body, result.status)
  }
  // Store only the PUBLIC identity (keyId for registry keys) in context — never
  // the raw secret-bearing `cxk_` key — so any future context reader / logging
  // middleware cannot leak the secret. Legacy env keys keep their raw value
  // (they are the operator's own secret; existing behaviour).
  c.set('apiKey', result.keyId === 'env:legacy' ? result.key : result.keyId)
  c.set('keyId', result.keyId)
  c.set('keyLabel', result.label)
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
  // Accept the ADMIN_SECRET OR a valid passkey admin-session token (0009 Phase 2,
  // model a). The session is HMAC-signed by ADMIN_SECRET, so it is only valid
  // while the secret is set/unrotated — the admin plane still has a single root.
  if (provided && (safeEqual(secret, provided) || verifyAdminSession(provided))) {
    return { ok: true }
  }
  return {
    ok: false,
    status: 401,
    body: {
      error: 'Admin authentication required',
      message: 'This operation requires the admin secret or a passkey session',
    },
  }
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const result = validateAdmin(c)
  if (!result.ok) {
    return c.json(result.body, result.status)
  }
  await next()
}
