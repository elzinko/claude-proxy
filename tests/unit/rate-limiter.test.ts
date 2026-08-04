import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../../src/middleware/rate-limiter'

// These exercise the in-memory path (no UPSTASH_* in the test env → redis is
// null). The security-critical property TL6 fixes is per-identifier isolation:
// each key-id gets its own bucket instead of all opaque key-ids collapsing onto
// one shared 'default' bucket. The Redis path mirrors the same semantics.
describe('RateLimiter (0008 TL6)', () => {
  it('allows up to maxRequests then blocks (per identifier)', async () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      expect((await rl.check('keyA')).allowed).toBe(true)
    }
    const blocked = await rl.check('keyA')
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('isolates buckets by key-id — two opaque key-ids do NOT share a limit', async () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })
    // key-id 1 spends its single allowance…
    expect((await rl.check('a1b2c3d4e5f6')).allowed).toBe(true)
    expect((await rl.check('a1b2c3d4e5f6')).allowed).toBe(false)
    // …a DIFFERENT key-id must still have its full allowance. Under the old
    // split('-') bucketing both (no '-') collapsed onto 'default' and this
    // second key would have been blocked.
    expect((await rl.check('999888777666')).allowed).toBe(true)
    expect((await rl.check('999888777666')).allowed).toBe(false)
  })

  it('reports remaining count down to zero', async () => {
    const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 })
    expect((await rl.check('k')).remaining).toBe(1)
    expect((await rl.check('k')).remaining).toBe(0)
  })

  it('getStats reflects the current window count and limit', async () => {
    const rl = new RateLimiter({ maxRequests: 5, windowMs: 60_000 })
    await rl.check('k')
    await rl.check('k')
    const s = await rl.getStats('k')
    expect(s.count).toBe(2)
    expect(s.limit).toBe(5)
  })
})
