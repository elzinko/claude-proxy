import { Redis } from '@upstash/redis'

interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

export interface RateLimitStats {
  count: number
  limit: number
  resetIn: number
}

// ── Redis wiring (same env vars as client-tracker / oauth-manager) ──────
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
const hasRedis = !!(redisUrl && redisToken)
const redis = hasRedis ? new Redis({ url: redisUrl!, token: redisToken! }) : null

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map()
  private config: RateLimitConfig

  constructor(config: RateLimitConfig = { maxRequests: 100, windowMs: 3600000 }) {
    this.config = config
  }

  // TL6 (0008): the limit must be (a) SHARED across serverless instances — the
  // old per-lambda Map meant the real ceiling was maxRequests × instance count
  // and reset on every cold start — and (b) keyed by the caller's STABLE key-id.
  // The previous code keyed on a split('-') of the key; registry key-ids have no
  // '-', so every per-app key collapsed onto a single 'default' bucket and shared
  // one limit. Redis gives a shared fixed-window counter per key-id; the
  // in-memory Map is a local-dev fallback only.
  //
  // Fails OPEN on a Redis error: a rate limiter is availability protection, not
  // access control — turning a Redis blip into a global deny would be a
  // self-inflicted outage. (Contrast isRevoked, which is auth and fails CLOSED.)
  async check(identifier: string): Promise<RateLimitResult> {
    const now = Date.now()
    const { maxRequests, windowMs } = this.config

    if (redis) {
      const windowStart = Math.floor(now / windowMs) * windowMs
      const resetAt = windowStart + windowMs
      const key = `ratelimit:${identifier}:${windowStart}`
      try {
        const count = await redis.incr(key)
        // Set the TTL once, on the first hit of a new aligned window. The key
        // embeds windowStart, so the next window is a fresh key regardless.
        if (count === 1) await redis.expire(key, Math.ceil(windowMs / 1000))
        return {
          allowed: count <= maxRequests,
          remaining: Math.max(0, maxRequests - count),
          resetAt,
        }
      } catch (err) {
        console.error('[rate-limiter] check failed — failing OPEN (allow):', err)
        return { allowed: true, remaining: maxRequests, resetAt }
      }
    }

    // In-memory fallback (local dev without Redis) — per-process rolling window.
    const entry = this.limits.get(identifier)
    if (!entry || now >= entry.resetAt) {
      this.limits.set(identifier, { count: 1, resetAt: now + windowMs })
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs }
    }
    if (entry.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt }
    }
    entry.count++
    return {
      allowed: true,
      remaining: maxRequests - entry.count,
      resetAt: entry.resetAt,
    }
  }

  async getStats(identifier: string): Promise<RateLimitStats> {
    const now = Date.now()
    const { maxRequests, windowMs } = this.config

    if (redis) {
      const windowStart = Math.floor(now / windowMs) * windowMs
      const resetAt = windowStart + windowMs
      const key = `ratelimit:${identifier}:${windowStart}`
      try {
        const raw = await redis.get<number | string>(key)
        const count =
          typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10) || 0
        return {
          count,
          limit: maxRequests,
          resetIn: Math.ceil((resetAt - now) / 1000),
        }
      } catch (err) {
        console.error('[rate-limiter] getStats failed:', err)
        return { count: 0, limit: maxRequests, resetIn: 0 }
      }
    }

    const entry = this.limits.get(identifier)
    if (!entry || now >= entry.resetAt) {
      return { count: 0, limit: maxRequests, resetIn: 0 }
    }
    return {
      count: entry.count,
      limit: maxRequests,
      resetIn: Math.ceil((entry.resetAt - now) / 1000),
    }
  }
}

export const rateLimiter = new RateLimiter({
  maxRequests: parseInt(process.env.RATE_LIMIT_REQUESTS || '100'),
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000'), // 1 hour
})
