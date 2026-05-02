// Multi-turn live regression — proves the prompt-cache holds across a
// growing conversation, not just a single 2-call replay.
//
// Pattern (mirrors strategies/04-long-session.sh in claude-proxy-probe):
// for each turn i = 1..N, send the same stable prefix (system + tools)
// plus the conversation history accumulated so far, then append a fresh
// "turn i: …" user message. Even though the messages array grows by one
// every turn, the prefix is byte-identical, so Anthropic should serve
// the prefix from cache on every turn after the first.
//
// What this catches that cache-hit.test.ts doesn't:
//   - Silent invalidators that only show up after 2+ turns (e.g. a turn
//     index leaked into the system prompt, a tool ordering change driven
//     by Map iteration, or a header-driven branch in the proxy that
//     toggles between turns).
//   - Cache-TTL regression: turn N runs ~3-5 s after turn 1; if the TTL
//     accidentally drops to <5 s, the regression catches it.
//
// Cost: N=4 Haiku calls × ~5K input tokens. After the first write, the
// remaining three turns read ~95 % from cache → effective cost ~= one
// uncached call. Runs only under LIVE_TESTS=1 (gated like cache-hit).
//
// Run explicitly:
//   PROXY_URL=https://<preview>.vercel.app \
//   PROBE_API_KEY=<same as Vercel API_KEY env var> \
//   PROBE_BYPASS_TOKEN=<Vercel Deployment Protection Bypass> \
//   LIVE_TESTS=1 \
//   npm run test:live

import { describe, expect, it } from 'vitest'
import {
  PROXY_URL,
  authHeaders,
  shouldRun,
  SYSTEM_FILLER,
  buildRealisticTools,
  type UsageShape,
} from './_payload'

const TURNS = 4

type Message = { role: string; content: string }

function buildPayload(history: Message[]) {
  return {
    model: 'claude-proxy-haiku-4.5',
    max_tokens: 10,
    messages: [
      { role: 'system', content: SYSTEM_FILLER },
      ...history,
    ],
    tools: buildRealisticTools(),
  }
}

async function call(history: Message[]): Promise<{
  status: number
  usage: UsageShape | undefined
  cacheCreationHeader: string | null
  cacheReadHeader: string | null
}> {
  const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(buildPayload(history)),
  })
  const body = (await r.json()) as { usage?: UsageShape } | null
  return {
    status: r.status,
    usage: body?.usage,
    cacheCreationHeader: r.headers.get('x-anthropic-cache-creation'),
    cacheReadHeader: r.headers.get('x-anthropic-cache-read'),
  }
}

describe.skipIf(!shouldRun)('live long-session regression (multi-turn cache stability)', () => {
  it(
    `prefix cache holds across ${TURNS} growing turns`,
    async () => {
      const history: Message[] = []
      const observations: Array<{
        turn: number
        cached: number
        created: number
      }> = []

      for (let i = 1; i <= TURNS; i++) {
        history.push({ role: 'user', content: `turn ${i}: say OK` })
        const r = await call(history)
        const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0
        const created = r.usage?.prompt_tokens_details?.cache_creation_tokens ?? 0
        observations.push({ turn: i, cached, created })
        console.log(
          `[turn ${i}] status=${r.status} cached=${cached} created=${created} ` +
          `(headers: read=${r.cacheReadHeader}, create=${r.cacheCreationHeader})`,
        )
        expect(r.status).toBe(200)

        // Tiny delay so the cache entry from turn N is committed before
        // turn N+1 fires. Empirically 500 ms is enough on a warm Vercel
        // edge; we keep it short to stay well inside the 5-min TTL even
        // if a CI runner stalls between turns.
        if (i < TURNS) await new Promise((r) => setTimeout(r, 500))
      }

      // Turn 1: the prefix is fresh, so we expect a cache write and
      // nothing to read. Use this as the baseline for "what the prefix
      // costs" — subsequent turns should read at least 70 % of it.
      const turn1 = observations[0]
      expect(turn1.created).toBeGreaterThan(0)
      expect(turn1.cached).toBe(0)
      const baseline = turn1.created

      // Turns 2..N: the prefix is identical, so the cache should hit on
      // every one. Allow a 30 % drop vs turn 1 to absorb the small
      // tokenization variance from the growing message tail (the tail
      // bytes themselves are *not* cached, only the prefix is).
      for (let i = 1; i < observations.length; i++) {
        const obs = observations[i]
        expect(obs.cached, `turn ${obs.turn} cached_tokens`).toBeGreaterThan(0)
        expect(obs.cached, `turn ${obs.turn} should read ≥70 % of baseline ${baseline}`)
          .toBeGreaterThanOrEqual(baseline * 0.7)
        // Turn 2+ shouldn't be paying to write the *same* prefix again.
        // We allow `created > 0` only as the per-turn tail amplification —
        // bounded well under the baseline. A blow-up here would mean the
        // proxy or Anthropic decided the prefix changed turn-to-turn,
        // which is exactly the silent-invalidator regression we want to
        // catch.
        expect(obs.created, `turn ${obs.turn} should not rewrite the prefix`)
          .toBeLessThan(baseline * 0.3)
      }
    },
    // (TURNS calls × ~10 s budget each) + buffer for slow cold start.
    120_000,
  )
})
