import { pool, queryRows, type Queryable } from '../../database/pool.js'
import { formatDayMonthYear, TODAY_IN_INDIA_SQL, type IsoDate } from '../../utils/dates.js'
import { logger } from '../../utils/logger.js'
import { recordAudit } from '../audit/audit.service.js'

/**
 * A leaver cannot sign in once their exit date is over.
 *
 * Sign-in, session refresh and every request check it (employmentEndedSql), so
 * it takes effect at midnight, India time, after the exit date - the exit date
 * itself is still a working day. deactivateLeavers then marks those logins
 * inactive, so the Users page shows them as they are.
 *
 * Only the login changes: the employee record stays as it is, so the leaver is
 * still paid their final salary.
 */

/** SQL that is true once the employee `alias` has left: their exit date is before today. */
export function employmentEndedSql(alias: string): string {
  return `(${alias}.exit_date IS NOT NULL AND ${alias}.exit_date < ${TODAY_IN_INDIA_SQL})`
}

/** Why a leaver's login is refused, naming the day they left. */
export function employmentEndedMessage(exitDate: IsoDate | null): string {
  return exitDate
    ? `Your employment ended on ${formatDayMonthYear(exitDate)}, so this account can no longer sign in`
    : 'Your employment has ended, so this account can no longer sign in'
}

/**
 * Marks the logins of everyone whose exit date is over as inactive, and ends
 * their sessions. Returns how many it deactivated.
 */
export async function deactivateLeavers(db: Queryable = pool): Promise<number> {
  const rows = await queryRows<{ id: string; organization_id: string; employee_code: string; exit_date: IsoDate }>(
    db,
    `UPDATE users u
        SET status = 'INACTIVE'
       FROM employees e
      WHERE e.user_id = u.id AND u.status = 'ACTIVE' AND ${employmentEndedSql('e')}
      RETURNING u.id, u.organization_id, e.employee_code, e.exit_date`,
  )

  for (const row of rows) {
    // Ends their sessions; auth.repository is not imported, as it imports this.
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.id])
    await recordAudit(
      {
        organizationId: row.organization_id,
        userId: null,
        action: 'USER_UPDATED',
        entityType: 'user',
        entityId: row.id,
        oldValues: { status: 'ACTIVE' },
        newValues: { status: 'INACTIVE', reason: 'Exit date passed', employeeCode: row.employee_code, exitDate: row.exit_date },
      },
      db,
    )
  }
  return rows.length
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Runs deactivateLeavers now and every hour after, so a leaver's login shows as
 * inactive within the hour after midnight. Their sign-in is refused from
 * midnight regardless (employmentEndedSql). Returns a function that stops it.
 */
export function scheduleLeaverDeactivation(): () => void {
  const run = (): void => {
    deactivateLeavers()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Deactivated the logins of employees whose exit date has passed')
      })
      .catch((error: unknown) => logger.error({ err: error }, 'Could not deactivate the logins of leavers'))
  }
  run()
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
