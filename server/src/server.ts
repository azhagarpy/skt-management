import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './utils/logger.js'
import { closePool, pool } from './database/pool.js'
import { migrateUp } from './database/migrate.js'
import { syncPermissionCatalogue } from './modules/auth/auth.service.js'

async function bootstrap(): Promise<void> {
  // Fail fast with a clear message rather than on the first request.
  await pool.query('SELECT 1')
  logger.info('Database connection established')

  const applied = await migrateUp()
  if (applied.length > 0) logger.info({ applied }, 'Pending migrations applied on startup')

  await syncPermissionCatalogue()

  const app = createApp()
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, prefix: env.API_PREFIX, env: env.NODE_ENV }, 'API listening')
  })

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down')
    server.close(() => {
      void closePool().then(() => process.exit(0))
    })
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection')
  })
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception, exiting')
    process.exit(1)
  })
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the API')
  process.exit(1)
})
