import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { buildUpdate } from '../organization/organization.repository.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { hashPassword } from '../auth/password.service.js'
import { PERMISSION_DEFINITIONS, PERMISSIONS, ROLE_PERMISSIONS, type RoleKey } from '../auth/permissions.js'
import { passwordSchema } from '../auth/auth.validation.js'

/**
 * User account and permission administration (plan sections 3 and 38).
 *
 * Roles carry a default permission set; this module also exposes the per-user
 * grant/deny overrides that let a Super Admin extend a supervisor - for example
 * granting team salary visibility - without inventing a new role.
 */

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(20).nullish(),
  role: z.enum(['SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE']),
  password: passwordSchema,
  employeeId: z.string().uuid().nullish(),
  mustChangePassword: z.boolean().default(true),
})

const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().max(20).nullish(),
  role: z.enum(['SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']).optional(),
  employeeId: z.string().uuid().nullish(),
})

const resetUserPasswordSchema = z.object({
  password: passwordSchema,
  mustChangePassword: z.boolean().default(true),
})

const permissionOverrideSchema = z.object({
  overrides: z
    .array(
      z.object({
        code: z.string().trim().min(2).max(60),
        granted: z.boolean(),
      }),
    )
    .max(200),
})

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: z.enum(['SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']).optional(),
})

const idParam = z.object({ id: z.string().uuid() })

interface UserRow {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: RoleKey
  status: string
  must_change_password: boolean
  last_login_at: Date | null
  created_at: Date
  employee_id: string | null
  employee_code: string | null
}

function present(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
  }
}

export const userRouter = Router()
userRouter.use(authenticate)

userRouter.get(
  '/',
  requirePermissions(PERMISSIONS.USER_VIEW),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as z.infer<typeof listQuerySchema>

    const conditions = ['u.organization_id = $1']
    const params: unknown[] = [auth.organizationId]
    const push = (value: unknown): number => {
      params.push(value)
      return params.length
    }

    if (filters.search) {
      const index = push(`%${filters.search}%`)
      conditions.push(`(u.email ILIKE $${index} OR u.full_name ILIKE $${index})`)
    }
    if (filters.role) conditions.push(`u.role = $${push(filters.role)}`)
    if (filters.status) conditions.push(`u.status = $${push(filters.status)}`)

    const rows = await queryRows<UserRow>(
      pool,
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status::text AS status,
              u.must_change_password, u.last_login_at, u.created_at,
              e.id AS employee_id, e.employee_code
         FROM users u
         LEFT JOIN employees e ON e.user_id = u.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY u.full_name`,
      params,
    )

    return sendSuccess(res, rows.map(present))
  }),
)

/** The permission catalogue plus each role's defaults, for the admin UI. */
userRouter.get(
  '/permissions/catalogue',
  requirePermissions(PERMISSIONS.PERMISSION_MANAGE),
  asyncHandler(async (_req, res) => {
    return sendSuccess(res, {
      permissions: PERMISSION_DEFINITIONS,
      roleDefaults: ROLE_PERMISSIONS,
    })
  }),
)

userRouter.post(
  '/',
  requirePermissions(PERMISSIONS.USER_MANAGE),
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as z.infer<typeof createUserSchema>

    const existing = await queryOne<{ id: string }>(pool, 'SELECT id FROM users WHERE lower(email) = lower($1)', [
      input.email,
    ])
    if (existing) throw ApiError.conflict('An account with this email already exists')

    const created = await withTransaction(async (tx) => {
      const user = await queryOne<UserRow>(
        tx,
        `INSERT INTO users (organization_id, email, password_hash, role, full_name, phone, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, full_name, phone, role, status::text AS status, must_change_password, last_login_at, created_at,
                   NULL::uuid AS employee_id, NULL::text AS employee_code`,
        [
          auth.organizationId,
          input.email,
          await hashPassword(input.password),
          input.role,
          input.fullName,
          input.phone ?? null,
          input.mustChangePassword,
        ],
      )

      if (input.employeeId && user) {
        // Linking is done from the employee side so the FK stays single-sided.
        const employee = await queryOne<{ id: string; user_id: string | null }>(
          tx,
          'SELECT id, user_id FROM employees WHERE id = $1 AND organization_id = $2',
          [input.employeeId, auth.organizationId],
        )
        if (!employee) throw ApiError.badRequest('The selected employee does not exist')
        if (employee.user_id) throw ApiError.conflict('That employee already has a login')
        await tx.query('UPDATE employees SET user_id = $2 WHERE id = $1', [input.employeeId, user.id])
      }

      return user
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: created?.id ?? null,
      newValues: { email: input.email, role: input.role, employeeId: input.employeeId ?? null },
    })

    return sendCreated(res, created ? present(created) : null, 'User created successfully')
  }),
)

userRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as z.infer<typeof updateUserSchema>

    const existing = await queryOne<UserRow>(
      pool,
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status::text AS status, u.must_change_password,
              u.last_login_at, u.created_at, e.id AS employee_id, e.employee_code
         FROM users u LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1 AND u.organization_id = $2`,
      [id, auth.organizationId],
    )
    if (!existing) throw ApiError.notFound('User')

    // Guard against an administrator locking themselves out.
    if (id === auth.userId && input.status && input.status !== 'ACTIVE') {
      throw ApiError.businessRule('You cannot deactivate your own account')
    }
    if (id === auth.userId && input.role && input.role !== existing.role) {
      throw ApiError.businessRule('You cannot change your own role')
    }

    const updated = await withTransaction(async (tx) => {
      const { assignments, params } = buildUpdate(
        {
          full_name: input.fullName,
          phone: input.phone,
          role: input.role,
          status: input.status,
        },
        3,
      )

      if (assignments.length > 0) {
        await tx.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2`, [
          id,
          auth.organizationId,
          ...params,
        ])
      }

      if (input.employeeId !== undefined) {
        await tx.query('UPDATE employees SET user_id = NULL WHERE user_id = $1', [id])
        if (input.employeeId) {
          await tx.query('UPDATE employees SET user_id = $2 WHERE id = $1 AND organization_id = $3', [
            input.employeeId,
            id,
            auth.organizationId,
          ])
        }
      }

      return queryOne<UserRow>(
        tx,
        `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status::text AS status, u.must_change_password,
                u.last_login_at, u.created_at, e.id AS employee_id, e.employee_code
           FROM users u LEFT JOIN employees e ON e.user_id = u.id
          WHERE u.id = $1`,
        [id],
      )
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: id,
      oldValues: { role: existing.role, status: existing.status },
      newValues: { role: input.role, status: input.status },
    })

    return sendSuccess(res, updated ? present(updated) : null, 'User updated successfully')
  }),
)

userRouter.post(
  '/:id/reset-password',
  requirePermissions(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: resetUserPasswordSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as z.infer<typeof resetUserPasswordSchema>

    const user = await queryOne<{ id: string }>(pool, 'SELECT id FROM users WHERE id = $1 AND organization_id = $2', [
      id,
      auth.organizationId,
    ])
    if (!user) throw ApiError.notFound('User')

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET password_hash = $2, password_changed_at = now(), must_change_password = $3,
                failed_login_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [id, await hashPassword(input.password), input.mustChangePassword],
      )
      // Every existing session for that user is invalidated.
      await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'USER_PASSWORD_RESET',
      entityType: 'user',
      entityId: id,
      newValues: { byAdministrator: true },
    })

    return sendSuccess(res, null, 'Password reset successfully')
  }),
)

userRouter.get(
  '/:id/permissions',
  requirePermissions(PERMISSIONS.PERMISSION_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string

    const user = await queryOne<{ id: string; role: RoleKey }>(
      pool,
      'SELECT id, role FROM users WHERE id = $1 AND organization_id = $2',
      [id, auth.organizationId],
    )
    if (!user) throw ApiError.notFound('User')

    const overrides = await queryRows<{ code: string; granted: boolean }>(
      pool,
      `SELECT p.code, up.granted
         FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id = $1`,
      [id],
    )

    const roleDefaults = ROLE_PERMISSIONS[user.role] ?? []
    const effective = new Set<string>(roleDefaults)
    for (const override of overrides) {
      if (override.granted) effective.add(override.code)
      else effective.delete(override.code)
    }

    return sendSuccess(res, {
      userId: id,
      role: user.role,
      roleDefaults,
      overrides,
      effective: [...effective].sort(),
    })
  }),
)

userRouter.put(
  '/:id/permissions',
  requirePermissions(PERMISSIONS.PERMISSION_MANAGE),
  validate({ params: idParam, body: permissionOverrideSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as z.infer<typeof permissionOverrideSchema>

    const user = await queryOne<{ id: string; role: RoleKey }>(
      pool,
      'SELECT id, role FROM users WHERE id = $1 AND organization_id = $2',
      [id, auth.organizationId],
    )
    if (!user) throw ApiError.notFound('User')

    // Changing your own permissions would let an administrator quietly escalate.
    if (id === auth.userId) {
      throw ApiError.businessRule('You cannot change your own permissions')
    }

    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM user_permissions WHERE user_id = $1', [id])
      for (const override of input.overrides) {
        const permission = await queryOne<{ id: string }>(tx, 'SELECT id FROM permissions WHERE code = $1', [
          override.code,
        ])
        if (!permission) throw ApiError.badRequest(`Unknown permission: ${override.code}`)
        await tx.query('INSERT INTO user_permissions (user_id, permission_id, granted) VALUES ($1, $2, $3)', [
          id,
          permission.id,
          override.granted,
        ])
      }
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'USER_PERMISSIONS_CHANGED',
      entityType: 'user',
      entityId: id,
      newValues: { overrides: input.overrides },
    })

    return sendSuccess(res, { userId: id, overrides: input.overrides }, 'Permissions updated successfully')
  }),
)
