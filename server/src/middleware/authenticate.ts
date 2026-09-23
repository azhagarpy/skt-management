import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../utils/api-error.js'
import { query } from '../database/pool.js'
import { verifyAccessToken } from '../modules/auth/token.service.js'
import type { PermissionCode, RoleKey } from '../modules/auth/permissions.js'
import { ROLE_PERMISSIONS } from '../modules/auth/permissions.js'
import type { AuthContext } from '../types/express.js'

interface UserRow {
  id: string
  organization_id: string
  role: RoleKey
  email: string
  full_name: string
  status: 'ACTIVE' | 'INACTIVE' | 'LOCKED'
  employee_id: string | null
}

interface PermissionRow {
  code: PermissionCode
  granted: boolean
}

function buildAuthContext(user: UserRow, overrides: PermissionRow[]): AuthContext {
  const permissions = new Set<PermissionCode>(ROLE_PERMISSIONS[user.role] ?? [])
  for (const override of overrides) {
    if (override.granted) permissions.add(override.code)
    else permissions.delete(override.code)
  }
  return {
    userId: user.id,
    organizationId: user.organization_id,
    role: user.role,
    email: user.email,
    fullName: user.full_name,
    employeeId: user.employee_id,
    permissions,
    has: (permission) => permissions.has(permission),
    hasAny: (...codes) => codes.some((code) => permissions.has(code)),
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.access_token
  return cookieToken ?? null
}

/**
 * Verifies the access token, then re-reads the user and their permission
 * overrides from the database on every request so a deactivated account or a
 * revoked permission takes effect immediately rather than at token expiry.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // Nested routers apply this middleware too; resolving the principal once per
    // request keeps that from costing an extra database round trip.
    if (req.auth) {
      next()
      return
    }

    const token = extractToken(req)
    if (!token) throw ApiError.unauthenticated()

    const payload = verifyAccessToken(token)

    const { rows } = await query<UserRow>(
      `SELECT u.id,
              u.organization_id,
              u.role,
              u.email,
              u.full_name,
              u.status,
              e.id AS employee_id
         FROM users u
         LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1`,
      [payload.sub],
    )

    const user = rows[0]
    if (!user) throw ApiError.unauthenticated('Account no longer exists')
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('This account is not active')

    const { rows: overrides } = await query<PermissionRow>(
      `SELECT p.code, up.granted
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id = $1`,
      [user.id],
    )

    req.auth = buildAuthContext(user, overrides)
    next()
  } catch (error) {
    next(error)
  }
}

/** Narrowing helper for controllers: throws rather than returning `undefined`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw ApiError.unauthenticated()
  return req.auth
}
