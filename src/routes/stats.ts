import { Hono } from 'hono'
import { logger } from '../middleware/request-logger'
import { requireAdmin } from './../middleware/require-api-key'

// TL5 (0008): usage stats and logs aggregate EVERY project's traffic, so they
// leak one app's activity to any other key holder. Gate the whole router behind
// ADMIN_SECRET — this is owner telemetry, not a client-tier read.
export const statsRouter = new Hono()

statsRouter.use('*', requireAdmin)

// GET /stats - Get usage statistics
statsRouter.get('/', (c) => {
  const project = c.req.query('project')
  const stats = logger.getStats(project)

  return c.json({
    stats,
    projects: stats.projects.map((proj) => ({
      name: proj,
      ...logger.getStats(proj),
    })),
  })
})

// GET /stats/logs - Get recent logs
statsRouter.get('/logs', (c) => {
  const project = c.req.query('project')
  const limit = parseInt(c.req.query('limit') || '50')
  
  const logs = logger.getLogs(project).slice(-limit)
  
  return c.json({ logs, total: logs.length })
})
