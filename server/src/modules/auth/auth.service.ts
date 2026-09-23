import { ApiError } from '../../utils/api-error.js'
import { logger } from '../../utils/logger.js'
import { withTransaction } from '../../database/tx.js'
import { pool } from '../../database/pool.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import * as repository from './auth.repository.js'
import { hashPassword, verifyPassword } from './password.service.js'
import {
  generateOpaqueToken,
  hashToken,
  passwordResetExpiry,
  refreshTokenExpiry,
  signAccessToken,
} from './token.service.js'
import { ROLE_PERMISSIONS, type PermissionCode, type RoleKey } from './permissions.js'

const MAX_FAILED_ATTEMPTS = 8
const LOCK_MINUTES = 15

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
}

export interface AuthResult {
  user: SessionUser
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

function effectivePermissions(role: RoleKey, overrides: { code: PermissionCode; granted: boolean }[]): PermissionCode[] {
  const permissions = new Set<PermissionCode>(ROLE_PERMISSIONS[role] ?? [])
  for (const override of overrides) {
    if (override.granted) permissions.add(override.code)
    else permissions.delete(override.code)
  }
  return [...permissions].sort()
}

async function buildSessionUser(user: repository.UserWithEmployee): Promise<SessionUser> {
  const overrides = await repository.findUserPermissionOverrides(user.id)
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
  }
}

async function issueSession(
  user: repository.UserWithEmployee,
  context: { userAgent?: string | null; ipAddress?: string | null },
): Promise<AuthResult> {
  const accessToken = signAccessToken({
    sub: user.id,
    organizationId: user.organization_id,
    role: user.role,
    employeeId: user.employee_id,
    tokenVersion: Math.floor(user.password_changed_at.getTime() / 1000),
  })

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

    const accessToken = signAccessToken({
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
      employeeId: user.employee_id,
      tokenVersion: Math.floor(user.password_changed_at.getTime() / 1000),
    })

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
      user: {
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
      },
      accessToken,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    }
  })
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
  if (!user || user.status !== 'ACTIVE') return {}

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
