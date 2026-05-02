// Live two-call regression — the only test that proves the cache actually
// works end-to-end. Fires two identical requests a few seconds apart and
// asserts the second one comes back with `cache_read_input_tokens > 0`.
// Reads the value out of `usage.prompt_tokens_details.cached_tokens` in
// the OpenAI-compat response, which is the same path openclaw and other
// OpenAI-compat clients use — so if this test passes, they'll see cache
// hits too.
//
// Excluded from `npm test` (vitest.config.ts only includes tests/live
// when LIVE_TESTS=1). Run explicitly:
//
//   PROXY_URL=https://<preview>.vercel.app \
//   PROBE_API_KEY=<same as Vercel API_KEY env var> \
//   PROBE_BYPASS_TOKEN=<Vercel Deployment Protection Bypass> \
//   LIVE_TESTS=1 \
//   npm run test:live
//
// Uses Haiku to keep quota cost minimal (two ~5K-token input calls ≈ a
// few cents). Live tests burn real OAuth quota every run — use sparingly.

import { describe, expect, it } from 'vitest'
import {
  PROXY_URL,
  authHeaders,
  shouldRun,
  SYSTEM_FILLER,
  buildRealisticTools,
  type UsageShape,
} from './_payload'

function buildPayload() {
  return {
    model: 'claude-proxy-haiku-4.5',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: SYSTEM_FILLER,
      },
      { role: 'user', content: 'pong' },
    ],
    tools: buildRealisticTools(),
  }
}

async function call(): Promise<{
  status: number
  usage: UsageShape | undefined
  cacheCreationHeader: string | null
  cacheReadHeader: string | null
  cacheControlInjected: string | null
}> {
  const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(buildPayload()),
  })
  const body = (await r.json()) as { usage?: UsageShape } | null
  return {
    status: r.status,
    usage: body?.usage,
    cacheCreationHeader: r.headers.get('x-anthropic-cache-creation'),
    cacheReadHeader: r.headers.get('x-anthropic-cache-read'),
    cacheControlInjected: r.headers.get('x-cache-control-injected'),
  }
}

describe.skipIf(!shouldRun)('live cache-hit regression (two-call pattern)', () => {
  it(
    'call 1 writes the cache, call 2 reads from it',
    async () => {
      // First call — expected to write the cache. Anthropic reports the
      // bytes written under cache_creation_input_tokens at ~1.25× rate.
      const first = await call()
      // Surface the numbers unconditionally so a CI-only regression (under
      // the 4096-token minimum, server-side token-counting differences,
      // etc.) is diagnosable straight from the job log without a local repro.
      console.log('[call 1] usage:', JSON.stringify(first.usage))
      console.log(
        '[call 1] headers:',
        JSON.stringify({
          injected: first.cacheControlInjected,
          create: first.cacheCreationHeader,
          read: first.cacheReadHeader,
        }),
      )
      expect(first.status).toBe(200)
      expect(first.cacheControlInjected).toBe('2') // system + tools breakpoints
      const firstCached =
        first.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const firstCreate =
        first.usage?.prompt_tokens_details?.cache_creation_tokens ?? 0
      expect(firstCreate).toBeGreaterThan(0)
      expect(firstCached).toBe(0) // nothing in cache to read yet

      // Small delay so the cache entry is committed before call 2 fires.
      // Prompt cache is readable once the first response begins streaming;
      // 500 ms is empirically enough on a warm Vercel edge.
      await new Promise((r) => setTimeout(r, 500))

      // Second call with the exact same payload — expected cache HIT.
      const second = await call()
      console.log('[call 2] usage:', JSON.stringify(second.usage))
      console.log(
        '[call 2] headers:',
        JSON.stringify({
          injected: second.cacheControlInjected,
          create: second.cacheCreationHeader,
          read: second.cacheReadHeader,
        }),
      )
      expect(second.status).toBe(200)
      const secondCached =
        second.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const secondCreate =
        second.usage?.prompt_tokens_details?.cache_creation_tokens ?? 0
      expect(secondCached).toBeGreaterThan(0)
      expect(secondCached).toBeGreaterThanOrEqual(firstCreate * 0.9)
      expect(secondCreate).toBe(0)

      // Response header mirror for human-readable inspection
      expect(Number(second.cacheReadHeader)).toBe(secondCached)
      expect(Number(second.cacheCreationHeader)).toBe(0)
    },
    30_000,
  )
})
