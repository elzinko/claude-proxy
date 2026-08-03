import { Hono } from 'hono'
import { requireApiKey, requireAdmin } from '../middleware/require-api-key'
import { tracker } from '../middleware/client-tracker'

// TL5 (0006): split into two sub-routers so the auth tier is per-operation
// while paths stay under /api/clients/*. READS are open to any valid client
// API key; destructive MUTATIONS (revoke/unrevoke) sit behind ADMIN_SECRET.
//
// Auth is attached PER ROUTE (requireApiKey / requireAdmin as the first
// handler) rather than via a sub-router `use('*', ...)`. When two sub-apps are
// both mounted at '/', Hono merges their wildcard middleware across the shared
// prefix, so a reads-tier `use('*', requireApiKey)` would run in front of the
// admin mutations (and 401 the admin secret), and vice-versa. Per-route
// middleware keeps each tier isolated while still preserving DEFAULT-DENY —
// every route names its own auth guard, none is mounted bare.
export const clientsRouter = new Hono()

// ── Reads (client API key) ──────────────────────────────────────────────
const clientReads = new Hono()

// GET /api/clients — list known clients with aggregated stats
clientReads.get('/', requireApiKey, async (c) => {
  const clients = await tracker.listClients()
  return c.json({
    retentionDays: tracker.retentionDays,
    backend: tracker.hasRedis ? 'redis' : 'memory',
    clients,
  })
})

// GET /api/clients/daily?days=30 — daily buckets for the usage chart
clientReads.get('/daily', requireApiKey, async (c) => {
  const raw = parseInt(c.req.query('days') || String(tracker.retentionDays))
  const days = Math.max(1, Math.min(tracker.retentionDays, isNaN(raw) ? tracker.retentionDays : raw))
  const daily = await tracker.getDailyStats(days)
  return c.json({ days, daily })
})

// ── Mutations (ADMIN_SECRET) ────────────────────────────────────────────
const clientAdmin = new Hono()

// POST /api/clients/:fp/revoke — block this fingerprint immediately
clientAdmin.post('/:fp/revoke', requireAdmin, async (c) => {
  const fp = c.req.param('fp')
  if (!fp || fp.length < 8) {
    return c.json({ error: 'Invalid fingerprint' }, 400)
  }
  try {
    await tracker.revoke(fp)
    return c.json({ success: true, fingerprint: fp, revoked: true })
  } catch (err) {
    return c.json(
      { error: 'Revoke failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /api/clients/:fp/unrevoke — re-allow a previously revoked fingerprint
clientAdmin.post('/:fp/unrevoke', requireAdmin, async (c) => {
  const fp = c.req.param('fp')
  if (!fp || fp.length < 8) {
    return c.json({ error: 'Invalid fingerprint' }, 400)
  }
  try {
    await tracker.unrevoke(fp)
    return c.json({ success: true, fingerprint: fp, revoked: false })
  } catch (err) {
    return c.json(
      { error: 'Unrevoke failed', message: (err as Error).message },
      500,
    )
  }
})

// Compose both sub-routers at the root so paths stay /api/clients/*.
// GET / and GET /daily resolve to clientReads (requireApiKey); the POST
// mutations resolve to clientAdmin (requireAdmin). Distinct methods+paths,
// no collision.
clientsRouter.route('/', clientReads)
clientsRouter.route('/', clientAdmin)
