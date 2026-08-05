import { createHmac, timingSafeEqual } from 'node:crypto'

// Short-lived admin SESSION token minted after a successful passkey assertion
// (0009 Phase 2, model a). It is an ALTERNATIVE to presenting ADMIN_SECRET —
// the owner unlocks the admin plane with Touch ID instead of pasting the secret.
// ADMIN_SECRET itself keeps working (base credential + break-glass) → no lockout.
//
// STATELESS by design: an HMAC over {exp} keyed by ADMIN_SECRET. This keeps
// validateAdmin() synchronous (no Redis round-trip on every admin request) and
// works on serverless. The trade-off is no pre-expiry revocation, mitigated by a
// short TTL. If ADMIN_SECRET is rotated, all outstanding sessions are invalidated
// for free (the signing key changed).

const PREFIX = 'was_' // WebAuthn Admin Session — distinguishes it from a raw secret
const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function mintAdminSession(
  ttlMs: number = DEFAULT_TTL_MS,
): { token: string; expiresAt: string } | null {
  const secret = process.env.ADMIN_SECRET?.trim()
  if (!secret) return null // no admin plane without ADMIN_SECRET → no sessions
  const exp = Date.now() + ttlMs
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return { token: `${PREFIX}${payload}.${sig}`, expiresAt: new Date(exp).toISOString() }
}

// Verify a session token: correct HMAC (constant-time) AND not expired. Pure and
// synchronous. Returns false for anything malformed, mis-signed, or stale.
export function verifyAdminSession(token: string): boolean {
  const secret = process.env.ADMIN_SECRET?.trim()
  if (!secret || typeof token !== 'string' || !token.startsWith(PREFIX)) return false
  const rest = token.slice(PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = rest.slice(0, dot)
  const sig = rest.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof parsed.exp === 'number' && parsed.exp > Date.now()
  } catch {
    return false
  }
}
