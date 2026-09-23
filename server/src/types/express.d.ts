import type { PermissionCode, RoleKey } from '../modules/auth/permissions.js'

/**
 * The authenticated principal attached to every request by `authenticate`.
 * `employeeId` is present whenever the user is linked to an employee record,
 * which is what ownership checks ("is this my own attendance?") rely on.
 */
export interface AuthContext {
  userId: string
  organizationId: string
  role: RoleKey
  email: string
  fullName: string
  employeeId: string | null
  permissions: Set<PermissionCode>
  has(permission: PermissionCode): boolean
  hasAny(...permissions: PermissionCode[]): boolean
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
      requestId?: string
    }
  }
}

export {}
