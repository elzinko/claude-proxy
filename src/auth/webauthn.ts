import type { Context } from 'hono'
import { Redis } from '@upstash/redis'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server'

// ── Passkeys / WebAuthn for the admin tier (0009, Phase 1: enrollment) ──────
// Registration ceremony only. The browser holds the biometric/private key; the
// server verifies an attestation signature and persists ONLY public material.
// Model-agnostic: the (a) 2FA vs (b) replace-ADMIN_SECRET decision lives in the
// authentication/enforcement phase, not here. Storage mirrors key-registry /
// client-tracker: Redis when configured, in-memory fallback for local dev.

const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
const hasRedis = !!(redisUrl && redisToken)
const redis = hasRedis ? new Redis({ url: redisUrl!, token: redisToken! }) : null

const K_CREDS = 'webauthn:creds' // HASH: credentialId -> JSON(StoredCredential)
const K_REG_CHALLENGE = 'webauthn:challenge:reg' // current registration challenge
const CHALLENGE_TTL_S = 300 // 5 minutes

// Single-owner proxy: one constant WebAuthn user identity.
const OWNER_USER_NAME = 'claude-proxy-admin'

export interface StoredCredential {
  id: string // base64url credential id (public)
  publicKey: string // base64 of the COSE public key bytes (NEVER a private key)
  counter: number // signature counter — anti-replay, bumped on each auth
  transports?: string[]
  label: string // human device label
  created: string // ISO
}

export interface CredentialListItem {
  id: string
  label: string
  created: string
  transports?: string[]
}

// ── In-memory fallback (local dev without Redis) ────────────────────────────
const memCreds = new Map<string, StoredCredential>()
let memChallenge: { challenge: string; exp: number } | null = null

// ── Uint8Array <-> base64 helpers (Redis stores JSON, not binary) ───────────
function u8ToB64(u: Uint8Array): string {
  return Buffer.from(u).toString('base64')
}
export function b64ToU8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

function decode<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
  return raw as T
}

// ── Relying-Party config: RP-ID must be a registrable suffix of the origin ──
// Derived from the request host so it works on any domain; override with env
// when fronting a custom domain. Changing the domain invalidates existing
// credentials (they are bound to the RP-ID) — re-enroll if so.
export function getRpConfig(c: Context): {
  rpID: string
  rpName: string
  origin: string
} {
  const url = new URL(c.req.url)
  const rpID = process.env.WEBAUTHN_RP_ID?.trim() || url.hostname
  const origin =
    process.env.WEBAUTHN_ORIGIN?.trim() || `${url.protocol}//${url.host}`
  return { rpID, rpName: 'claude-proxy', origin }
}

// ── Credential storage ──────────────────────────────────────────────────────
export async function listCredentials(): Promise<CredentialListItem[]> {
  const toItem = (c: StoredCredential): CredentialListItem => ({
    id: c.id,
    label: c.label,
    created: c.created,
    transports: c.transports,
  })
  if (!redis) {
    return Array.from(memCreds.values())
      .map(toItem)
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  }
  try {
    const map = (await redis.hgetall(K_CREDS)) as Record<string, unknown> | null
    if (!map) return []
    return Object.values(map)
      .map((raw) => decode<StoredCredential>(raw))
      .filter((c): c is StoredCredential => !!c)
      .map(toItem)
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  } catch (err) {
    console.error('[webauthn] listCredentials failed:', err)
    return []
  }
}

async function getCredential(id: string): Promise<StoredCredential | null> {
  if (!redis) return memCreds.get(id) ?? null
  try {
    return decode<StoredCredential>(await redis.hget(K_CREDS, id))
  } catch (err) {
    console.error('[webauthn] getCredential failed:', err)
    return null
  }
}

async function putCredential(cred: StoredCredential): Promise<void> {
  if (!redis) {
    memCreds.set(cred.id, cred)
    return
  }
  try {
    await redis.hset(K_CREDS, { [cred.id]: JSON.stringify(cred) })
  } catch (err) {
    console.error('[webauthn] putCredential failed:', err)
    throw new Error('Failed to persist credential')
  }
}

export async function deleteCredential(id: string): Promise<boolean> {
  if (!redis) return memCreds.delete(id)
  try {
    const n = await redis.hdel(K_CREDS, id)
    return (n || 0) > 0
  } catch (err) {
    console.error('[webauthn] deleteCredential failed:', err)
    throw new Error('Failed to delete credential')
  }
}

// ── Challenge storage (single-owner → one pending registration challenge) ───
async function putRegChallenge(challenge: string): Promise<void> {
  if (!redis) {
    memChallenge = { challenge, exp: Date.now() + CHALLENGE_TTL_S * 1000 }
    return
  }
  await redis.set(K_REG_CHALLENGE, challenge, { ex: CHALLENGE_TTL_S })
}

async function takeRegChallenge(): Promise<string | null> {
  if (!redis) {
    const cur = memChallenge
    memChallenge = null
    if (!cur || cur.exp < Date.now()) return null
    return cur.challenge
  }
  try {
    // GETDEL is atomic — no get-then-del race between concurrent verifies.
    const val = await redis.getdel<string>(K_REG_CHALLENGE)
    return val ?? null
  } catch (err) {
    console.error('[webauthn] takeRegChallenge failed:', err)
    return null
  }
}

// ── Registration ceremony ───────────────────────────────────────────────────
export async function startRegistration(c: Context) {
  const { rpID, rpName } = getRpConfig(c)
  const existing = await listCredentials()
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: OWNER_USER_NAME,
    // Discourage re-registering the same authenticator.
    excludeCredentials: existing.map((cred) => ({
      id: cred.id,
      transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      // Require user verification (biometric / PIN) — this credential guards the
      // admin plane, and the whole point is "empreinte pour valider".
      userVerification: 'required',
    },
  })
  await putRegChallenge(options.challenge)
  return options
}

export async function finishRegistration(
  c: Context,
  response: RegistrationResponseJSON,
  label: string,
): Promise<{ verified: boolean; credentialId?: string; error?: string }> {
  const expectedChallenge = await takeRegChallenge()
  if (!expectedChallenge) {
    return { verified: false, error: 'No pending challenge (expired or unsolicited)' }
  }
  const { rpID, origin } = getRpConfig(c)

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    })
  } catch (err) {
    return { verified: false, error: (err as Error).message }
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, error: 'Attestation not verified' }
  }

  const { credential } = verification.registrationInfo
  const stored: StoredCredential = {
    id: credential.id,
    publicKey: u8ToB64(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    label: (label || 'passkey').slice(0, 60),
    created: new Date().toISOString(),
  }
  await putCredential(stored)
  return { verified: true, credentialId: stored.id }
}

export const webauthn = {
  hasRedis,
  getRpConfig,
  startRegistration,
  finishRegistration,
  listCredentials,
  getCredential,
  deleteCredential,
}
