import { createHash, randomBytes } from 'node:crypto'
import { Redis } from '@upstash/redis'
import { redactUpstashError } from '../auth/oauth-manager'

// ── Redis wiring (same env vars / style as client-tracker & oauth-manager) ──
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
const hasRedis = !!(redisUrl && redisToken)
const redis = hasRedis ? new Redis({ url: redisUrl!, token: redisToken! }) : null

// ── Redis keys (distinct `apikeys:*` namespace) ─────────────────────────
// K_REGISTRY is the AUTHORITY record — written ONLY by mint + revoke/unrevoke.
// K_LASTUSED is telemetry, kept in a SEPARATE hash so touchLastUsed can never
// read-modify-write the authority record (a race there could RESURRECT a
// revoked key — the whole point of splitting the two).
const K_REGISTRY = 'apikeys:registry' // HASH keyId -> JSON(KeyRecord)
const K_LASTUSED = 'apikeys:lastused' // HASH keyId -> ISO timestamp

// ── Types ───────────────────────────────────────────────────────────────
export interface KeyRecord {
  keyId: string
  secretHash: string // sha256(secret) hex — never the secret itself
  label: string
  created: string // ISO
  status: 'active' | 'revoked'
}

export interface KeyListItem {
  keyId: string
  label: string
  created: string
  lastUsed: string | null
  status: 'active' | 'revoked'
}

export interface MintResult {
  key: string // plaintext `cxk_<keyId>_<secret>` — returned ONCE, never stored
  keyId: string
  label: string
  created: string
}

// Discriminated + fail-closed: callers must never treat an error as a success.
export type GetKeyResult =
  | { found: true; record: KeyRecord }
  | { found: false }
  | { error: true }

// ── In-memory fallback (local dev without Redis) ────────────────────────
const memRegistry = new Map<string, KeyRecord>()
const memLastUsed = new Map<string, string>()

// ── Helpers ─────────────────────────────────────────────────────────────
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Upstash returns hash fields either pre-parsed or as raw strings. Normalize.
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

// On Vercel, Redis is REQUIRED — the in-memory Map is per-lambda and does not
// persist, so silently using it would mint keys that vanish on the next cold
// start. Throw a clear misconfig error for writes; reads fail CLOSED instead.
function vercelRequiresRedis(op: string): Error {
  return new Error(
    `Cannot ${op} API keys on Vercel without Redis. ` +
      'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in ' +
      'Settings → Environment Variables (include the Preview scope), then redeploy.',
  )
}

// ── mint ────────────────────────────────────────────────────────────────
async function mint(label: string): Promise<MintResult> {
  const keyId = randomBytes(6).toString('hex') // 12 hex chars
  const secret = randomBytes(32).toString('base64url') // may contain '_' / '-'
  const created = new Date().toISOString()
  const record: KeyRecord = {
    keyId,
    secretHash: sha256Hex(secret),
    label,
    created,
    status: 'active',
  }

  if (!redis) {
    if (process.env.VERCEL === '1') throw vercelRequiresRedis('mint')
    memRegistry.set(keyId, record)
  } else {
    try {
      await redis.hset(K_REGISTRY, { [keyId]: JSON.stringify(record) })
    } catch (err) {
      // Redact the Upstash "command was:" payload; never log the key/secret.
      console.error('[key-registry] mint failed:', redactUpstashError(err as Error))
      throw new Error('Failed to persist API key to Redis')
    }
  }

  // The plaintext key exists only in this return value.
  return { key: `cxk_${keyId}_${secret}`, keyId, label, created }
}

// ── getKey (discriminated, fail-closed) ─────────────────────────────────
async function getKey(keyId: string): Promise<GetKeyResult> {
  if (!redis) {
    // Prod without Redis: cannot authoritatively answer — fail closed.
    if (process.env.VERCEL === '1') return { error: true }
    const rec = memRegistry.get(keyId)
    return rec ? { found: true, record: rec } : { found: false }
  }
  try {
    const rec = decode<KeyRecord>(await redis.hget(K_REGISTRY, keyId))
    if (!rec) return { found: false }
    return { found: true, record: rec }
  } catch (err) {
    console.error(
      '[key-registry] getKey failed — failing CLOSED (deny):',
      redactUpstashError(err as Error),
    )
    return { error: true }
  }
}

// ── listKeys (metadata only — never secretHash / plaintext) ─────────────
async function listKeys(): Promise<KeyListItem[]> {
  const toItem = (rec: KeyRecord, lastUsed: string | null): KeyListItem => ({
    keyId: rec.keyId,
    label: rec.label,
    created: rec.created,
    lastUsed,
    status: rec.status,
  })

  if (!redis) {
    const items = Array.from(memRegistry.values()).map((rec) =>
      toItem(rec, memLastUsed.get(rec.keyId) ?? null),
    )
    items.sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    return items
  }
  try {
    const [regMap, usedMap] = await Promise.all([
      redis.hgetall(K_REGISTRY) as Promise<Record<string, unknown> | null>,
      redis.hgetall(K_LASTUSED) as Promise<Record<string, unknown> | null>,
    ])
    if (!regMap) return []
    const items: KeyListItem[] = []
    for (const [keyId, raw] of Object.entries(regMap)) {
      const rec = decode<KeyRecord>(raw)
      if (!rec) continue
      const lu = usedMap ? usedMap[keyId] : undefined
      items.push(toItem({ ...rec, keyId }, lu == null ? null : String(lu)))
    }
    items.sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    return items
  } catch (err) {
    console.error('[key-registry] listKeys failed:', redactUpstashError(err as Error))
    return []
  }
}

// ── revoke / unrevoke (flip status on the AUTHORITY record, by key-id) ───
async function setStatus(
  keyId: string,
  status: 'active' | 'revoked',
): Promise<boolean> {
  if (!redis) {
    if (process.env.VERCEL === '1') throw vercelRequiresRedis('revoke')
    const rec = memRegistry.get(keyId)
    if (!rec) return false
    rec.status = status
    return true
  }
  try {
    const rec = decode<KeyRecord>(await redis.hget(K_REGISTRY, keyId))
    if (!rec) return false
    rec.status = status
    await redis.hset(K_REGISTRY, { [keyId]: JSON.stringify(rec) })
    return true
  } catch (err) {
    console.error('[key-registry] setStatus failed:', redactUpstashError(err as Error))
    throw new Error('Failed to update API key status')
  }
}

async function revokeKey(keyId: string): Promise<boolean> {
  return setStatus(keyId, 'revoked')
}

async function unrevokeKey(keyId: string): Promise<boolean> {
  return setStatus(keyId, 'active')
}

// ── revokeAll (0004 global kill — flip EVERY key to revoked, by key-id) ──
// The downstream "revoke for everything": disables all per-app keys at once so
// no client can authenticate. Returns the count of keys newly revoked. Does NOT
// touch the env API_KEY (that is rotated via the environment) nor the upstream
// Anthropic token (see SECURITY.md — that revocation is a manual claude.ai step).
async function revokeAll(): Promise<number> {
  if (!redis) {
    let n = 0
    for (const rec of memRegistry.values()) {
      if (rec.status !== 'revoked') {
        rec.status = 'revoked'
        n++
      }
    }
    return n
  }
  try {
    const map = (await redis.hgetall(K_REGISTRY)) as Record<
      string,
      unknown
    > | null
    if (!map) return 0
    const updates: Record<string, string> = {}
    let n = 0
    for (const [keyId, raw] of Object.entries(map)) {
      const rec = decode<KeyRecord>(raw)
      if (!rec || rec.status === 'revoked') continue
      updates[keyId] = JSON.stringify({ ...rec, keyId, status: 'revoked' })
      n++
    }
    if (n > 0) await redis.hset(K_REGISTRY, updates)
    return n
  } catch (err) {
    console.error('[key-registry] revokeAll failed:', redactUpstashError(err as Error))
    throw new Error('Failed to revoke all API keys')
  }
}

// ── touchLastUsed (telemetry — throttled, fire-and-forget, never denies) ─
const TOUCH_THROTTLE_MS = 60_000
const touchThrottle = new Map<string, number>()

function touchLastUsed(keyId: string): void {
  const now = Date.now()
  const prev = touchThrottle.get(keyId)
  if (prev != null && now - prev < TOUCH_THROTTLE_MS) return
  touchThrottle.set(keyId, now)
  const iso = new Date(now).toISOString()

  if (!redis) {
    memLastUsed.set(keyId, iso)
    return
  }
  // Fire-and-forget: writes ONLY to the separate lastused hash, never the
  // authority record. Must not block the request or throw into the caller.
  redis.hset(K_LASTUSED, { [keyId]: iso }).catch((err) => {
    console.error(
      '[key-registry] touchLastUsed failed (ignored):',
      redactUpstashError(err as Error),
    )
  })
}

// ── hasAnyKey (HLEN>0, or mem size) ─────────────────────────────────────
async function hasAnyKey(): Promise<boolean> {
  if (!redis) return memRegistry.size > 0
  try {
    const n = await redis.hlen(K_REGISTRY)
    return (n || 0) > 0
  } catch (err) {
    console.error('[key-registry] hasAnyKey failed:', redactUpstashError(err as Error))
    return false
  }
}

export const registry = {
  mint,
  listKeys,
  getKey,
  revokeKey,
  unrevokeKey,
  revokeAll,
  touchLastUsed,
  hasAnyKey,
  hasRedis,
}
