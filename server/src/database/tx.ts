import type { PoolClient } from 'pg'
import { pool, type Queryable } from './pool.js'
import { logger } from '../utils/logger.js'

export type TxClient = PoolClient & Queryable

/**
 * Runs `work` inside a single PostgreSQL transaction, rolling back on any error.
 *
 * Plan section 56 requires this for payroll calculation, approval, locking,
 * payment writes and leave approval + attendance updates.
 */
export async function withTransaction<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as TxClient
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Failed to roll back transaction')
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Serialises concurrent work on the same logical resource (for example a payroll
 * run) using a transaction-scoped PostgreSQL advisory lock.
 */
export async function withAdvisoryLock<T>(tx: TxClient, key: string, work: () => Promise<T>): Promise<T> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
  return work()
}
