import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ApiError } from '../utils/api-error.js'
import type { PermissionCode, RoleKey } from '../modules/auth/permissions.js'
import { requireAuth } from './authenticate.js'

/** Requires every listed permission. */
export function requirePermissions(...permissions: PermissionCode[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireAuth(req)
      const missing = permissions.filter((permission) => !auth.has(permission))
      if (missing.length > 0) {
        throw ApiError.forbidden('You do not have permission to perform this action')
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...permissions: PermissionCode[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireAuth(req)
      if (!auth.hasAny(...permissions)) {
        throw ApiError.forbidden('You do not have permission to perform this action')
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function requireRole(...roles: RoleKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireAuth(req)
      if (!roles.includes(auth.role)) {
        throw ApiError.forbidden('This action is restricted to a different role')
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
