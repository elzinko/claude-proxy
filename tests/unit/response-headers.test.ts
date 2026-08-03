import { describe, expect, it } from 'vitest'
import type { Context } from 'hono'
import {
  forwardSafeResponseHeaders,
  FORWARDED_UPSTREAM_HEADERS,
} from '../../src/server'

// Minimal fake Context that records every c.header(key, value) call so we can
// assert exactly which upstream headers get forwarded downstream.
function recordingCtx(): { c: Context; forwarded: Record<string, string> } {
  const forwarded: Record<string, string> = {}
  const c = {
    header: (k: string, v: string) => {
      forwarded[k.toLowerCase()] = v
    },
  } as unknown as Context
  return { c, forwarded }
}

describe('TL8 (0008) — upstream response-header allowlist', () => {
  it('forwards ONLY content-type; drops account/identity headers', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'text/event-stream',
        'anthropic-organization-id': 'org_should_not_leak',
        'request-id': 'req_should_not_leak',
        'anthropic-ratelimit-requests-remaining': '42',
        'cf-ray': 'deadbeef-CDG',
        'set-cookie': 'session=should_not_leak',
        via: '1.1 google',
      },
    })

    const { c, forwarded } = recordingCtx()
    forwardSafeResponseHeaders(c, response)

    // The one header a client legitimately needs (SSE vs JSON) passes through.
    expect(forwarded['content-type']).toBe('text/event-stream')

    // None of the account-correlatable headers may reach the downstream client.
    for (const leak of [
      'anthropic-organization-id',
      'request-id',
      'anthropic-ratelimit-requests-remaining',
      'cf-ray',
      'set-cookie',
      'via',
    ]) {
      expect(forwarded[leak]).toBeUndefined()
    }
  })

  it('the allowlist is minimal and contains no identity headers', () => {
    expect(FORWARDED_UPSTREAM_HEADERS.has('content-type')).toBe(true)
    expect(FORWARDED_UPSTREAM_HEADERS.has('anthropic-organization-id')).toBe(false)
    expect(FORWARDED_UPSTREAM_HEADERS.has('request-id')).toBe(false)
    expect(FORWARDED_UPSTREAM_HEADERS.has('anthropic-ratelimit-requests-remaining')).toBe(false)
  })
})
