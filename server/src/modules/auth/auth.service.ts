import { ApiError } from '../../utils/api-error.js'
import { logger } from '../../utils/logger.js'
import { withTransaction } from '../../database/tx.js'
import { pool } from '../../database/pool.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import * as repository from './auth.repository.js'
import { employmentEndedMessage } from './leavers.js'
import { hashPassword, verifyPassword } from './password.service.js'
import {
  generateOpaqueToken,
  hashToken,
  passwordResetExpiry,
  readAccessTokenIgnoringExpiry,
  refreshTokenExpiry,
  signAccessToken,
} from './token.service.js'
import { ROLE_PERMISSIONS, type PermissionCode, type RoleKey } from './permissions.js'

const MAX_FAILED_ATTEMPTS = 8
const LOCK_MINUTES = 15
/** Wrong PINs in a row before the session is signed out and the password is needed. */
export const MAX_PIN_ATTEMPTS = 5

export interface SessionUser {
  id: string
  email: string
  fullName: string
  role: RoleKey
  organizationId: string
  employeeId: string | null
  employeeCode: string | null
  mustChangePassword: boolean
  permissions: PermissionCode[]
  lastLoginAt: string | null
  /** An app lock PIN is set, so the site asks for it each time it is opened. */
  appPinEnabled: boolean
}

export interface AuthResult {
  user: SessionUser
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: string
  /** The access token is waiting for the PIN; only the unlock endpoint accepts it. */
  appLocked: boolean
}

function effectivePermissions(role: RoleKey, overrides: { code: PermissionCode; granted: boolean }[]): PermissionCode[] {
  const permissions = new Set<PermissionCode>(ROLE_PERMISSIONS[role] ?? [])
  for (const override of overrides) {
    if (override.granted) permissions.add(override.code)
    else permissions.delete(override.code)
  }
  return [...permissions].sort()
}

function presentSessionUser(
  user: repository.UserWithEmployee,
  overrides: { code: PermissionCode; granted: boolean }[],
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    organizationId: user.organization_id,
    employeeId: user.employee_id,
    employeeCode: user.employee_code,
    mustChangePassword: user.must_change_password,
    permissions: effectivePermissions(user.role, overrides),
    lastLoginAt: user.last_login_at ? user.last_login_at.toISOString() : null,
    appPinEnabled: user.app_pin_hash !== null,
  }
}

async function buildSessionUser(user: repository.UserWithEmployee): Promise<SessionUser> {
  return presentSessionUser(user, await repository.findUserPermissionOverrides(user.id))
}

function tokenVersionOf(user: repository.UserWithEmployee): number {
  return Math.floor(user.password_changed_at.getTime() / 1000)
}

function accessTokenFor(user: repository.UserWithEmployee, pinLocked: boolean): string {
  return signAccessToken({
    sub: user.id,
    organizationId: user.organization_id,
    role: user.role,
    employeeId: user.employee_id,
    tokenVersion: tokenVersionOf(user),
    ...(pinLocked ? { pinLocked: true } : {}),
  })
}

/**
 * Whether a refreshed session must wait for the PIN.
 *
 * "Opening the site" is told apart from a routine refresh by the access token
 * the page sends along: it lives only in the page's memory, so a page that was
 * just opened has none, while an open page presents its current (possibly
 * expired) one - as does a reloaded page, which the page before it handed its
 * token on to (AuthProvider.tsx). A page that already unlocked stays unlocked; anything else -
 * no token, a locked one, someone else's, or one from before a password
 * change - has to enter the PIN.
 */
export function refreshNeedsPin(user: repository.UserWithEmployee, previousAccessToken: string | undefined): boolean {
  if (user.app_pin_hash === null) return false
  const previous = previousAccessToken ? readAccessTokenIgnoringExpiry(previousAccessToken) : null
  const unlockedHere =
    previous !== null &&
    previous.sub === user.id &&
    previous.pinLocked !== true &&
    previous.tokenVersion === tokenVersionOf(user)
  return !unlockedHere
}

/** Signing in with the password is proof enough: a fresh sign-in is never locked. */
async function issueSession(
  user: repository.UserWithEmployee,
  context: { userAgent?: string | null; ipAddress?: string | null },
): Promise<AuthResult> {
  const accessToken = accessTokenFor(user, false)

  const { token, hash } = generateOpaqueToken()
  const expiresAt = refreshTokenExpiry()
  await repository.storeRefreshToken({
    userId: user.id,
    tokenHash: hash,
    expiresAt,
    userAgent: context.userAgent ?? null,
    ipAddress: context.ipAddress ?? null,
  })

  return {
    user: await buildSessionUser(user),
    accessToken,
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    appLocked: false,
  }
}

/**
 * Authenticates by email or employee code.
 *
 * The same generic message is returned whether the account is missing or the
 * password is wrong, so the endpoint cannot be used to enumerate accounts.
 */
export async function login(
  input: { identifier: string; password: string },
  context: AuditContext,
): Promise<AuthResult> {
  const invalidCredentials = ApiError.unauthenticated('Invalid credentials')
  const user = await repository.findUserByIdentifier(input.identifier)

  if (!user) {
    await recordAudit({
      ...context,
      organizationId: null,
      userId: null,
      action: 'USER_LOGIN_FAILED',
      entityType: 'user',
      newValues: { identifier: input.identifier, reason: 'UNKNOWN_ACCOUNT' },
    })
    throw invalidCredentials
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    throw ApiError.forbidden('This account is temporarily locked after too many failed sign-in attempts')
  }

  if (user.status !== 'ACTIVE') {
    throw ApiError.forbidden('This account is not active')
  }

  const passwordMatches = await verifyPassword(input.password, user.password_hash)
  if (!passwordMatches) {
    await repository.recordFailedLogin(user.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES)
    await recordAudit({
      ...context,
      organizationId: user.organization_id,
      userId: user.id,
      action: 'USER_LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      newValues: { reason: 'BAD_PASSWORD' },
    })
    throw invalidCredentials
  }

  // Checked only after the password, so the leaving date is shown to no one else.
  if (user.employment_ended) {
    await recordAudit({
      ...context,
      organizationId: user.organization_id,
      userId: user.id,
      action: 'USER_LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      newValues: { reason: 'EMPLOYMENT_ENDED', exitDate: user.employee_exit_date },
    })
    throw ApiError.forbidden(employmentEndedMessage(user.employee_exit_date))
  }

  await repository.recordSuccessfulLogin(user.id)
  const result = await issueSession(user, { userAgent: context.userAgent, ipAddress: context.ipAddress })

  await recordAudit({
    ...context,
    organizationId: user.organization_id,
    userId: user.id,
    action: 'USER_LOGIN',
    entityType: 'user',
    entityId: user.id,
  })

  return result
}

/**
 * Rotates a refresh token: the presented token is revoked and replaced. Reusing
 * an already-revoked token revokes the whole family, which is the standard
 * response to a suspected token theft.
 */
export async function refresh(
  refreshTokenValue: string,
  context: { userAgent?: string | null; ipAddress?: string | null },
  previousAccessToken?: string,
): Promise<AuthResult> {
  const tokenHash = hashToken(refreshTokenValue)

  return withTransaction(async (tx) => {
    const stored = await repository.findRefreshToken(tokenHash, tx)
    if (!stored) throw ApiError.unauthenticated('Invalid refresh token')

    if (stored.revoked_at) {
      await repository.revokeAllRefreshTokensForUser(stored.user_id, tx)
      logger.warn({ userId: stored.user_id }, 'Reuse of a revoked refresh token detected; all sessions revoked')
      throw ApiError.unauthenticated('This session is no longer valid, please sign in again')
    }

    if (stored.expires_at.getTime() <= Date.now()) {
      throw ApiError.unauthenticated('Session expired, please sign in again')
    }

    const user = await repository.findUserById(stored.user_id, tx)
    if (!user) throw ApiError.unauthenticated('Account no longer exists')
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('This account is not active')
    if (user.employment_ended) {
      await repository.revokeAllRefreshTokensForUser(user.id, tx)
      throw ApiError.forbidden(employmentEndedMessage(user.employee_exit_date))
    }

    const appLocked = refreshNeedsPin(user, previousAccessToken)
    const accessToken = accessTokenFor(user, appLocked)

    const { token, hash } = generateOpaqueToken()
    const expiresAt = refreshTokenExpiry()
    const newId = await repository.storeRefreshToken(
      {
        userId: user.id,
        tokenHash: hash,
        expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
      tx,
    )
    await repository.revokeRefreshToken(stored.id, newId || null, tx)

    const overrides = await repository.findUserPermissionOverrides(user.id, tx)
    return {
      user: presentSessionUser(user, overrides),
      accessToken,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt.toISOString(),
      appLocked,
    }
  })
}

// ---------------------------------------------------------------------------
// App lock PIN
// ---------------------------------------------------------------------------

/**
 * Exchanges a locked access token for an unlocked one when the PIN is right.
 *
 * Wrong PINs are counted per user. After MAX_PIN_ATTEMPTS in a row this
 * session's refresh token is revoked, so whoever is guessing is back at the
 * password screen; a four-digit PIN is only safe behind a limit like this.
 */
export async function unlockWithPin(
  userId: string,
  pin: string,
  refreshTokenValue: string | undefined,
  context: AuditContext,
): Promise<{ user: SessionUser; accessToken: string; appLocked: false }> {
  const user = await repository.findUserById(userId)
  if (!user) throw ApiError.unauthenticated('Account no longer exists')
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('This account is not active')

  // The lock was turned off since this page was opened: nothing to check.
  const matches = user.app_pin_hash === null || (await verifyPassword(pin, user.app_pin_hash))
  if (matches) {
    if (user.app_pin_failed_attempts > 0) await repository.resetFailedPins(user.id)
    return { user: await buildSessionUser(user), accessToken: accessTokenFor(user, false), appLocked: false }
  }

  const attempts = await repository.recordFailedPin(user.id)
  const auditBase = { ...context, organizationId: user.organization_id, userId: user.id, entityType: 'user', entityId: user.id }

  if (attempts >= MAX_PIN_ATTEMPTS) {
    await withTransaction(async (tx) => {
      const stored = refreshTokenValue ? await repository.findRefreshToken(hashToken(refreshTokenValue), tx) : null
      if (stored && stored.user_id === user.id) await repository.revokeRefreshToken(stored.id, null, tx)
      else await repository.revokeAllRefreshTokensForUser(user.id, tx)
      await repository.resetFailedPins(user.id, tx)
      await recordAudit({ ...auditBase, action: 'APP_PIN_LOCKOUT', newValues: { attempts } }, tx)
    })
    throw ApiError.unauthenticated('Too many wrong PINs. Sign in with your password to continue.')
  }

  await recordAudit({ ...auditBase, action: 'APP_PIN_FAILED', newValues: { attempts } })
  const left = MAX_PIN_ATTEMPTS - attempts
  throw ApiError.badRequest(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left before you are signed out.`)
}

async function requireCurrentPassword(userId: string, currentPassword: string): Promise<repository.UserWithEmployee> {
  const user = await repository.findUserById(userId)
  if (!user) throw ApiError.notFound('Account')
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw ApiError.badRequest('Your password is incorrect')
  }
  return user
}

/**
 * Turns the app lock on, or changes the PIN. The account password is asked
 * for so that someone at an already-unlocked screen cannot set a PIN of their
 * own - or, in `removeAppPin`, take the lock off.
 */
export async function setAppPin(
  userId: string,
  input: { pin: string; currentPassword: string },
  context: AuditContext,
): Promise<SessionUser> {
  const user = await requireCurrentPassword(userId, input.currentPassword)
  await repository.updateAppPin(user.id, await hashPassword(input.pin))
  await recordAudit({
    ...context,
    action: 'APP_PIN_SET',
    entityType: 'user',
    entityId: user.id,
    newValues: { changed: user.app_pin_hash !== null },
  })
  return currentUser(user.id)
}

export async function removeAppPin(
  userId: string,
  input: { currentPassword: string },
  context: AuditContext,
): Promise<SessionUser> {
  const user = await requireCurrentPassword(userId, input.currentPassword)
  await repository.updateAppPin(user.id, null)
  await recordAudit({ ...context, action: 'APP_PIN_REMOVED', entityType: 'user', entityId: user.id })
  return currentUser(user.id)
}

export async function logout(refreshTokenValue: string | undefined, context: AuditContext): Promise<void> {
  if (refreshTokenValue) {
    const stored = await repository.findRefreshToken(hashToken(refreshTokenValue))
    if (stored) await repository.revokeRefreshToken(stored.id, null)
  } else if (context.userId) {
    await repository.revokeAllRefreshTokensForUser(context.userId)
  }

  if (context.userId) {
    await recordAudit({ ...context, action: 'USER_LOGOUT', entityType: 'user', entityId: context.userId })
  }
}

export interface ForgotPasswordResult {
  /**
   * Only returned outside production so the reset flow can be exercised without
   * an email provider. Production responses never include the token.
   */
  resetToken?: string
}

export async function forgotPassword(email: string, includeToken: boolean): Promise<ForgotPasswordResult> {
  const user = await repository.findUserByEmail(email)
  // Always succeed: revealing whether an address exists would leak accounts.
  if (!user || user.status !== 'ACTIVE' || user.employment_ended) return {}

  const { token, hash } = generateOpaqueToken()
  await repository.invalidateOtherResetTokens(user.id)
  await repository.storePasswordResetToken({ userId: user.id, tokenHash: hash, expiresAt: passwordResetExpiry() })

  logger.info({ userId: user.id }, 'Password reset token issued')
  return includeToken ? { resetToken: token } : {}
}

export async function resetPassword(token: string, newPassword: string, context: AuditContext): Promise<void> {
  const tokenHash = hashToken(token)

  await withTransaction(async (tx) => {
    const stored = await repository.findPasswordResetToken(tokenHash, tx)
    if (!stored || stored.used_at || stored.expires_at.getTime() <= Date.now()) {
      throw ApiError.badRequest('This password reset link is invalid or has expired')
    }

    const user = await repository.findUserById(stored.user_id, tx)
    if (!user) throw ApiError.notFound('Account')

    const sameAsCurrent = await verifyPassword(newPassword, user.password_hash)
    if (sameAsCurrent) throw ApiError.businessRule('Choose a password you have not used before')

    await repository.updatePassword(user.id, await hashPassword(newPassword), tx)
    await repository.markPasswordResetTokenUsed(stored.id, tx)
    // Every existing session is invalidated after a reset.
    await repository.revokeAllRefreshTokensForUser(user.id, tx)

    await recordAudit(
      { ...context, organizationId: user.organization_id, userId: user.id, action: 'USER_PASSWORD_RESET', entityType: 'user', entityId: user.id },
      tx,
    )
  })
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  context: AuditContext,
): Promise<void> {
  const user = await repository.findUserById(userId)
  if (!user) throw ApiError.notFound('Account')

  const matches = await verifyPassword(input.currentPassword, user.password_hash)
  if (!matches) throw ApiError.badRequest('Your current password is incorrect')

  if (input.currentPassword === input.newPassword) {
    throw ApiError.businessRule('The new password must be different from the current one')
  }

  await withTransaction(async (tx) => {
    await repository.updatePassword(user.id, await hashPassword(input.newPassword), tx)
    await repository.revokeAllRefreshTokensForUser(user.id, tx)
    await recordAudit({ ...context, action: 'USER_PASSWORD_CHANGED', entityType: 'user', entityId: user.id }, tx)
  })
}

export async function currentUser(userId: string): Promise<SessionUser> {
  const user = await repository.findUserById(userId)
  if (!user) throw ApiError.notFound('Account')
  return buildSessionUser(user)
}

/**
 * Syncs the permission catalogue into the database and re-applies role defaults.
 * Runs on startup so a newly added permission is immediately usable.
 */
export async function syncPermissionCatalogue(): Promise<void> {
  const { PERMISSION_DEFINITIONS } = await import('./permissions.js')
  await withTransaction(async (tx) => {
    for (const definition of PERMISSION_DEFINITIONS) {
      await tx.query(
        `INSERT INTO permissions (code, description, module)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, module = EXCLUDED.module`,
        [definition.code, definition.description, definition.module],
      )
    }
  })
  const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM permissions')
  logger.info({ permissions: rows[0]?.count }, 'Permission catalogue synced')
}
