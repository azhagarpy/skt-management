/**
 * Startup smoke check.
 *
 * Builds the Express app and exercises the health endpoints without touching
 * PostgreSQL, which verifies that every module and router in the graph imports
 * and mounts cleanly. Run with `npm run smoke`.
 */
import { createApp } from './app.js'
import { env } from './config/env.js'

const app = createApp()

const server = app.listen(0, async () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`

  const checks: { name: string; url: string; expect: number }[] = [
    { name: 'health', url: `${base}/health`, expect: 200 },
    { name: 'api health', url: `${base}${env.API_PREFIX}/health`, expect: 200 },
    { name: 'unknown route returns 404', url: `${base}${env.API_PREFIX}/does-not-exist`, expect: 404 },
    { name: 'protected route requires auth', url: `${base}${env.API_PREFIX}/employees`, expect: 401 },
  ]

  let failures = 0
  for (const check of checks) {
    try {
      const response = await fetch(check.url)
      const ok = response.status === check.expect
      if (!ok) failures += 1
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${check.name} (${response.status}, expected ${check.expect})\n`)
    } catch (error) {
      failures += 1
      process.stdout.write(`FAIL  ${check.name}: ${(error as Error).message}\n`)
    }
  }

  server.close()
  process.exit(failures === 0 ? 0 : 1)
})
