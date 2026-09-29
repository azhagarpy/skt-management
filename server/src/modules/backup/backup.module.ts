import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from 'express'
import archiver from 'archiver'
import { env } from '../../config/env.js'
import { pool, queryOne } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { logger } from '../../utils/logger.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { localStorageRoot } from '../documents/storage.service.js'

/**
 * Full backup download (Settings > Backup).
 *
 * One zip holds everything needed to rebuild the system's data: a pg_dump of
 * the whole database and every uploaded file. The dump is written to a temp
 * file and checked before the zip starts streaming, because once the first
 * byte is sent a failure can no longer be reported - the admin would simply
 * receive a broken zip.
 *
 * Secrets (.env: database password, JWT keys) are deliberately left out: the
 * archive is downloaded to a browser, and a new server gets fresh secrets.
 */

/** pg_dump from PG_DUMP_PATH, else PATH, else the newest Windows install. */
function pgDumpBinary(): string {
  if (env.PG_DUMP_PATH) return env.PG_DUMP_PATH
  if (process.platform !== 'win32') return 'pg_dump'

  const root = 'C:\\Program Files\\PostgreSQL'
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((name) => /^\d+(\.\d+)?$/.test(name))
      .sort((a, b) => Number(b) - Number(a))
    for (const version of versions) {
      const candidate = join(root, version, 'bin', 'pg_dump.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return 'pg_dump.exe'
}

/**
 * The connection is passed to pg_dump through its environment rather than as
 * an argument, so the password never shows up in the server's process list.
 */
function pgEnvironment(): NodeJS.ProcessEnv {
  const url = new URL(env.DATABASE_URL)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return {
    ...process.env,
    // A socket connection carries its host as ?host=/var/run/postgresql.
    PGHOST: url.hostname || url.searchParams.get('host') || '',
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    ...(env.DATABASE_SSL ? { PGSSLMODE: 'require' } : {}),
  }
}

/** Runs pg_dump and resolves with its stdout, or rejects with its first error line. */
function runPgDump(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pgDumpBinary(), args, { env: pgEnvironment(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? backupError('pg_dump was not found on the server. Install the PostgreSQL client tools or set PG_DUMP_PATH.')
          : error,
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else {
        const firstLine = stderr.split(/\r?\n/).find((line) => line.trim()) ?? `pg_dump exited with code ${code}`
        reject(backupError(`The database could not be backed up: ${firstLine.trim()}`))
      }
    })
  })
}

/** A 500 whose message is shown to the admin, so a failed backup says why. */
function backupError(message: string): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', message, [], true)
}

/** Every file under a folder, for the manifest's count and size. */
async function folderSummary(root: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(root)) return { files: 0, bytes: 0 }
  const summary = { files: 0, bytes: 0 }
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        summary.files += 1
        summary.bytes += (await stat(path)).size
      }
    }
  }
  await walk(root)
  return summary
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const RESTORE_GUIDE = (database: string, pgDumpVersion: string) => `SKT Payroll - full backup
========================

Contents
  database.dump   The whole PostgreSQL database (pg_dump custom format).
  storage/        Every uploaded file: employee documents, photos, logos,
                  payment proofs and organization documents.
  manifest.json   When and by whom this backup was taken, and what is in it.

Not included: the server's .env file (database password, JWT secrets).
Keep a copy of it somewhere safe, or create a new one on the new server.

This archive holds Aadhaar, PAN, bank and salary details for every employee.
Store it encrypted and never share it.

Restoring
---------
1. Stop the API (pm2 stop skt-api).

2. Recreate the database and load the dump. This dump was made by
   ${pgDumpVersion}; restore it with pg_restore of that version or newer:
     dropdb   ${database}
     createdb ${database}
     pg_restore --no-owner --no-acl -d ${database} database.dump
   Add -h/-U options, or run as the postgres user, as your server needs.

3. Put the files back: copy the contents of storage/ into the folder
   STORAGE_LOCAL_DIR points at (for example /opt/skt/storage).

4. Start the API (pm2 start skt-api). Pending migrations, if any, run on start.
`

let backupRunning = false

export const backupRouter = Router()
backupRouter.use(authenticate)

backupRouter.get(
  '/',
  requirePermissions(PERMISSIONS.BACKUP_DOWNLOAD),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    if (env.STORAGE_DRIVER !== 'local') {
      throw ApiError.businessRule('Full backups include uploaded files, which is only supported with local storage.')
    }
    // One at a time: a dump reads the whole database and is not cheap.
    if (backupRunning) throw ApiError.conflict('A backup is already being prepared. Try again in a minute.')
    backupRunning = true

    const workDir = await mkdtemp(join(tmpdir(), 'skt-backup-'))
    const dumpFile = join(workDir, 'database.dump')
    let cleanedUp = false
    const cleanUp = async (): Promise<void> => {
      if (cleanedUp) return
      cleanedUp = true
      backupRunning = false
      await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn({ error, workDir }, 'Could not remove the backup working folder')
      })
    }

    try {
      const database = pgEnvironment().PGDATABASE ?? 'database'
      const [pgDumpVersion] = await Promise.all([
        runPgDump(['--version']),
        runPgDump(['--format=custom', '--no-password', `--file=${dumpFile}`]),
      ])
      const dumpBytes = (await stat(dumpFile)).size
      const files = await folderSummary(localStorageRoot)
      const migration = await queryOne<{ name: string; count: string }>(
        pool,
        'SELECT max(name) AS name, count(*)::text AS count FROM schema_migrations',
        [],
      ).catch(() => null)

      const createdAt = new Date()
      const manifest = {
        application: 'SKT Payroll',
        createdAt: createdAt.toISOString(),
        createdBy: auth.email,
        database: {
          name: database,
          file: 'database.dump',
          format: 'pg_dump custom (restore with pg_restore)',
          bytes: dumpBytes,
          pgDump: pgDumpVersion.trim(),
          migrationsApplied: Number(migration?.count ?? 0),
          latestMigration: migration?.name ?? null,
        },
        storage: { folder: 'storage/', files: files.files, bytes: files.bytes },
      }

      await recordAudit({
        ...auditContextFrom(req),
        action: 'BACKUP_DOWNLOADED',
        entityType: 'backup',
        entityId: null,
        newValues: { databaseBytes: dumpBytes, files: files.files, fileBytes: files.bytes },
      })

      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="skt-backup-${timestamp(createdAt)}.zip"`)
      res.setHeader('Cache-Control', 'private, no-store')

      const archive = archiver('zip', { zlib: { level: 6 } })
      archive.on('warning', (warning) => logger.warn({ warning }, 'Backup archive warning'))
      archive.on('error', (error) => {
        logger.error({ err: error }, 'Backup archive failed while streaming')
        res.destroy(error)
      })
      res.on('close', () => void cleanUp())

      archive.pipe(res)
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
      archive.append(RESTORE_GUIDE(database, pgDumpVersion.trim()), { name: 'README.txt' })
      archive.file(dumpFile, { name: 'database.dump' })
      if (existsSync(localStorageRoot)) archive.directory(localStorageRoot, 'storage')
      await archive.finalize()
    } catch (error) {
      await cleanUp()
      throw error
    }
  }),
)
