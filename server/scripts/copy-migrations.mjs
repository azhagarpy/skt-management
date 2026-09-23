// tsc only emits JavaScript, so the .sql migration files never reach dist/.
// migrate.ts resolves its directory relative to the running file, which means a
// production build (node dist/server.js) cannot find them unless they are copied
// alongside the compiled output.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(serverRoot, 'src', 'database', 'migrations')
const to = join(serverRoot, 'dist', 'database', 'migrations')

await mkdir(to, { recursive: true })
await cp(from, to, { recursive: true })
console.log(`copied migrations -> ${to}`)
