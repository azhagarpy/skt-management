import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import type { IsoDate } from '../../utils/dates.js'
import { employmentEndedSql } from './leavers.js'
import type { PermissionCode, RoleKey } from './permissions.js'

export interface UserRecord {
  id: string
  organization_id: string
  email: string
  password_hash: string
  role: RoleKey
  status: 'ACTIVE' | 'INACTIVE' | 'LOCKED'
  full_name: string
  phone: string | null
  must_change_password: boolean
  failed_login_attempts: number
  locked_until: Date | null
  last_login_at: Date | null
  password_changed_at: Date
  /** bcrypt hash of the app lock PIN; null when the lock is off. */
  app_pin_hash: string | null
  app_pin_failed_attempts: number
}

export interface UserWithEmployee extends UserRecord {
  employee_id: string | null
  employee_code: string | null
  employee_exit_date: IsoDate | null
  /** The linked employee's exit date is over: they may no longer sign in (leavers.ts). */
  employment_ended: boolean
}

const USER_SELECT = `
  SELECT u.id,
         u.organization_id,
         u.email,
         u.password_hash,
         u.role,
         u.status,
         u.full_name,
         u.phone,
         u.must_change_password,
         u.failed_login_attempts,
         u.locked_until,
         u.last_login_at,
         u.password_changed_at,
         u.app_pin_hash,
         u.app_pin_failed_attempts,
         e.id   AS employee_id,
         e.employee_code,
         e.exit_date AS employee_exit_date,
         coalesce(${employmentEndedSql('e')}, false) AS employment_ended
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.id
`

/** Looks a user up by email or by employee code, as the login form allows both. */
export async function findUserByIdentifier(identifier: string, db: Queryable = pool): Promise<UserWithEmployee | null> {
  return queryOne<UserWithEmployee>(
    db,
    `${USER_SELECT} WHERE lower(u.email) = lower($1) OR upper(e.employee_code) = upper($1) LIMIT 1`,
    [identifier],
  )
}

export async function findUserById(userId: string, db: Queryable = pool): Promise<UserWithEmployee | null> {
  return queryOne<UserWithEmployee>(db, `${USER_SELECT} WHERE u.id = $1`, [userId])
}

export async function findUserByEmail(email: string, db: Queryable = pool): Promise<UserWithEmployee | null> {
  return queryOne<UserWithEmployee>(db, `${USER_SELECT} WHERE lower(u.email) = lower($1)`, [email])
}

export async function recordSuccessfulLogin(userId: string, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE users
        SET last_login_at = now(), failed_login_attempts = 0, locked_until = NULL, app_pin_failed_attempts = 0
      WHERE id = $1`,
    [userId],
  )
}

/**
 * Counts a failed attempt and locks the account once the threshold is reached.
 * Locking is time-based so an administrator does not have to intervene.
 */
export async function recordFailedLogin(
  userId: string,
  maxAttempts: number,
  lockMinutes: number,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
              ELSE locked_until
            END
      WHERE id = $1`,
    [userId, maxAttempts, String(lockMinutes)],
  )
}

export async function updatePassword(userId: string, passwordHash: string, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            must_change_password = FALSE,
            failed_login_attempts = 0,
            locked_until = NULL
      WHERE id = $1`,
    [userId, passwordHash],
  )
}

// ---------------------------------------------------------------------------
// App lock PIN
// ---------------------------------------------------------------------------

/** Sets the PIN hash, or clears it (turning the lock off) when null. */
export async function updateAppPin(userId: string, pinHash: string | null, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE users
        SET app_pin_hash = $2, app_pin_updated_at = now(), app_pin_failed_attempts = 0
      WHERE id = $1`,
    [userId, pinHash],
  )
}

/** Counts a wrong PIN and returns the running total. */
export async function recordFailedPin(userId: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ attempts: number }>(
    db,
    `UPDATE users SET app_pin_failed_attempts = app_pin_failed_attempts + 1
      WHERE id = $1 RETURNING app_pin_failed_attempts AS attempts`,
    [userId],
  )
  return row?.attempts ?? 0
}

export async function resetFailedPins(userId: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE users SET app_pin_failed_attempts = 0 WHERE id = $1', [userId])
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface RefreshTokenRecord {
  id: string
  user_id: string
  expires_at: Date
  revoked_at: Date | null
}

export async function storeRefreshToken(
  params: { userId: string; tokenHash: string; expiresAt: Date; userAgent?: string | null; ipAddress?: string | null },
  db: Queryable = pool,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    db,
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.userId, params.tokenHash, params.expiresAt, params.userAgent ?? null, params.ipAddress ?? null],
  )
  return row?.id ?? ''
}

export async function findRefreshToken(tokenHash: string, db: Queryable = pool): Promise<RefreshTokenRecord | null> {
  return queryOne<RefreshTokenRecord>(
    db,
    'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash],
  )
}

export async function revokeRefreshToken(id: string, replacedBy: string | null, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1 AND revoked_at IS NULL', [
    id,
    replacedBy,
  ])
}

export async function revokeAllRefreshTokensForUser(userId: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
}

export async function deleteExpiredRefreshTokens(db: Queryable = pool): Promise<number> {
  const result = await db.query('DELETE FROM refresh_tokens WHERE expires_at < now() - interval \'30 days\'')
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// Password reset tokens
// ---------------------------------------------------------------------------

export async function storePasswordResetToken(
  params: { userId: string; tokenHash: string; expiresAt: Date },
  db: Queryable = pool,
): Promise<void> {
  await db.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    params.userId,
    params.tokenHash,
    params.expiresAt,
  ])
}

export interface PasswordResetRecord {
  id: string
  user_id: string
  expires_at: Date
  used_at: Date | null
}

export async function findPasswordResetToken(
  tokenHash: string,
  db: Queryable = pool,
): Promise<PasswordResetRecord | null> {
  return queryOne<PasswordResetRecord>(
    db,
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1',
    [tokenHash],
  )
}

export async function markPasswordResetTokenUsed(id: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [id])
}

export async function invalidateOtherResetTokens(userId: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId])
}

// ---------------------------------------------------------------------------
// Permission overrides
// ---------------------------------------------------------------------------

export async function findUserPermissionOverrides(
  userId: string,
  db: Queryable = pool,
): Promise<{ code: PermissionCode; granted: boolean }[]> {
  return queryRows<{ code: PermissionCode; granted: boolean }>(
    db,
    `SELECT p.code, up.granted
       FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
      WHERE up.user_id = $1`,
    [userId],
  )
}
