import { Hono } from 'hono'
import { getTokenMetadata } from '../auth/oauth-manager'
import { logger } from '../middleware/request-logger'
import { rateLimiter } from '../middleware/rate-limiter'
import { requireAdmin, isApiKeyConfiguredAsync } from '../middleware/require-api-key'
import { getDeploymentHealth } from '../utils/deployment-check'

// TL5 (0008): /full exposes token metadata + per-project usage + deployment
// warnings. That is owner-only diagnostics — gate behind ADMIN_SECRET, not the
// client key tier.
export const statusRouter = new Hono()

statusRouter.use('*', requireAdmin)

// GET /api/status/full — full diagnostics (no secrets)
statusRouter.get('/full', async (c) => {
  const project = c.req.query('project')
  const [metadata, deployment, apiKeyConfigured] = await Promise.all([
    getTokenMetadata(),
    getDeploymentHealth(),
    isApiKeyConfiguredAsync(),
  ])
  const stats = logger.getStats(project)

  return c.json({
    auth: {
      ...metadata,
      apiKeyConfigured,
    },
    deployment,
    stats: {
      totalRequests: stats.totalRequests,
      requestsLastHour: stats.requestsLastHour,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      projects: stats.projects.map((proj) => ({
        name: proj,
        ...logger.getStats(proj),
        rateLimit: rateLimiter.getStats(proj),
      })),
    },
  })
})
