import { beforeEach, describe, expect, it, vi } from 'vitest'

// TL7 (0008): a blocked/revoked caller must not be able to drive an ipinfo
// lookup. We mock the provenance module so we can assert whether trackRequest
// reached the upstream resolver, without any network. EMPTY_PROVENANCE must be
// exported by the mock too — client-tracker imports it as the default value.
const { lookupSpy, EMPTY } = vi.hoisted(() => ({
  lookupSpy: vi.fn(),
  EMPTY: { asn: null, asnOrg: null, netType: 'unknown', ptr: null, hostLabel: null },
}))

vi.mock('../../src/middleware/ip-provenance', () => ({
  lookupProvenance: lookupSpy,
  EMPTY_PROVENANCE: EMPTY,
}))

import { tracker } from '../../src/middleware/client-tracker'

function track(blocked: boolean, ip: string, fingerprint: string) {
  return tracker.trackRequest({
    fingerprint,
    apiKey: 'cxk_test',
    ip,
    ua: 'curl/8',
    country: null,
    tokensIn: 0,
    tokensOut: 0,
    blocked,
  })
}

describe('trackRequest — provenance enrichment gating (TL7 0008)', () => {
  beforeEach(() => {
    lookupSpy.mockReset()
    lookupSpy.mockResolvedValue(EMPTY)
  })

  it('does NOT call lookupProvenance for a BLOCKED request', async () => {
    await track(true, '203.0.113.7', 'fp-blocked')
    expect(lookupSpy).not.toHaveBeenCalled()
  })

  it('DOES call lookupProvenance for an ALLOWED request (with the trusted IP)', async () => {
    await track(false, '198.51.100.9', 'fp-allowed')
    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(lookupSpy).toHaveBeenCalledWith('198.51.100.9', null)
  })
})
