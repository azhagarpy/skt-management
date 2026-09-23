import pg from 'pg'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

const { Pool, types } = pg

/**
 * pg returns NUMERIC as a string by default to avoid precision loss. We keep that
 * behaviour (money is parsed explicitly through utils/money) but force DATE to a
 * plain `YYYY-MM-DD` string so attendance dates never shift across timezones.
 */
const DATE_OID = 1082
types.setTypeParser(DATE_OID, (value: string) => value)

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'skt-payroll-api',
})

pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected error on idle PostgreSQL client')
})

export type QueryParam = unknown

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParam[],
  ): Promise<pg.QueryResult<T>>
}

/** Runs a query on the shared pool. Prefer passing an explicit `Queryable` inside transactions. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params)
}

export async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params)
  return result.rows
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const result = await db.query<T>(text, params)
  return result.rows[0] ?? null
}

export async function closePool(): Promise<void> {
  await pool.end()
}
