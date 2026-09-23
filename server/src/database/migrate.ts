import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import { logger } from '../utils/logger.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
const UP_MARKER = '-- +migrate Up'
const DOWN_MARKER = '-- +migrate Down'
const LOCK_KEY = 4_814_772

interface Migration {
  name: string
  up: string
  down: string
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  for (const file of files) {
    const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const downIndex = contents.indexOf(DOWN_MARKER)
    const body = downIndex === -1 ? contents : contents.slice(0, downIndex)
    const down = downIndex === -1 ? '' : contents.slice(downIndex + DOWN_MARKER.length)
    const upIndex = body.indexOf(UP_MARKER)
    const up = upIndex === -1 ? body : body.slice(upIndex + UP_MARKER.length)
    migrations.push({ name: file, up: up.trim(), down: down.trim() })
  }
  return migrations
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  )
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
  return new Set(rows.map((row) => row.name))
}

export async function migrateUp(): Promise<string[]> {
  await ensureMigrationsTable()
  const client = await pool.connect()
  const executed: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    const applied = await appliedMigrations()
    const migrations = await loadMigrations()
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue
      logger.info({ migration: migration.name }, 'Applying migration')
      try {
        await client.query('BEGIN')
        await client.query(migration.up)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name])
        await client.query('COMMIT')
        executed.push(migration.name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    client.release()
  }
  return executed
}

export async function migrateDown(steps = 1): Promise<string[]> {
  await ensureMigrationsTable()
  const client = await pool.connect()
  const reverted: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT $1',
      [steps],
    )
    const migrations = new Map((await loadMigrations()).map((migration) => [migration.name, migration]))
    for (const row of rows) {
      const migration = migrations.get(row.name)
      if (!migration || !migration.down) {
        throw new Error(`Migration ${row.name} has no Down section and cannot be reverted`)
      }
      logger.info({ migration: row.name }, 'Reverting migration')
      try {
        await client.query('BEGIN')
        await client.query(migration.down)
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [row.name])
        await client.query('COMMIT')
        reverted.push(row.name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Reverting ${row.name} failed: ${(error as Error).message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    client.release()
  }
  return reverted
}

export async function migrationStatus(): Promise<{ name: string; applied: boolean }[]> {
  await ensureMigrationsTable()
  const applied = await appliedMigrations()
  const migrations = await loadMigrations()
  return migrations.map((migration) => ({ name: migration.name, applied: applied.has(migration.name) }))
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up'
  try {
    if (command === 'up') {
      const executed = await migrateUp()
      logger.info({ executed }, executed.length ? 'Migrations applied' : 'Database already up to date')
    } else if (command === 'down') {
      const steps = Number(process.argv[3] ?? 1)
      const reverted = await migrateDown(Number.isFinite(steps) ? steps : 1)
      logger.info({ reverted }, 'Migrations reverted')
    } else if (command === 'status') {
      const status = await migrationStatus()
      for (const entry of status) {
        process.stdout.write(`${entry.applied ? '[x]' : '[ ]'} ${entry.name}\n`)
      }
    } else {
      throw new Error(`Unknown migrate command: ${command}`)
    }
    await pool.end()
  } catch (error) {
    logger.error({ err: error }, 'Migration command failed')
    await pool.end()
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (invokedDirectly) {
  void main()
}
