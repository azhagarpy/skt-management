import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import { buildPaginated, offsetOf } from '../../utils/pagination.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { AUDIT_ACTIONS } from './audit.service.js'

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
  search: z.string().trim().max(120).optional(),
})

interface AuditRow {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  old_values: unknown
  new_values: unknown
  ip_address: string | null
  user_agent: string | null
  created_at: Date
  user_name: string | null
  user_email: string | null
}

export const auditRouter = Router()
auditRouter.use(authenticate)

/** The audit trail is admin-only and read-only: rows are never edited or deleted. */
auditRouter.get(
  '/',
  requirePermissions(PERMISSIONS.AUDIT_VIEW),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as z.infer<typeof listQuerySchema>

    const conditions = ['a.organization_id = $1']
    const params: unknown[] = [auth.organizationId]
    const push = (value: unknown): number => {
      params.push(value)
      return params.length
    }

    if (filters.action) conditions.push(`a.action = $${push(filters.action)}`)
    if (filters.entityType) conditions.push(`a.entity_type = $${push(filters.entityType)}`)
    if (filters.entityId) conditions.push(`a.entity_id = $${push(filters.entityId)}`)
    if (filters.userId) conditions.push(`a.user_id = $${push(filters.userId)}`)
    if (filters.from) conditions.push(`a.created_at >= $${push(filters.from)}::timestamptz`)
    if (filters.to) conditions.push(`a.created_at <= $${push(filters.to)}::timestamptz`)
    if (filters.search) {
      const index = push(`%${filters.search}%`)
      conditions.push(`(a.action ILIKE $${index} OR a.entity_type ILIKE $${index} OR u.full_name ILIKE $${index})`)
    }

    const clause = conditions.join(' AND ')

    const countRow = await queryOne<{ count: string }>(
      pool,
      `SELECT count(*)::text AS count FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${clause}`,
      params,
    )

    const rows = await queryRows<AuditRow>(
      pool,
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.old_values, a.new_values,
              a.ip_address, a.user_agent, a.created_at,
              u.full_name AS user_name, u.email AS user_email
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${clause}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
    )

    const result = buildPaginated(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        oldValues: row.old_values,
        newValues: row.new_values,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        userName: row.user_name,
        userEmail: row.user_email,
        createdAt: row.created_at,
      })),
      Number(countRow?.count ?? 0),
      filters.page,
      filters.pageSize,
    )

    return sendSuccess(res, result.items, undefined, 200, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

/** The action vocabulary, so the client can offer a filter without guessing. */
auditRouter.get(
  '/actions',
  requirePermissions(PERMISSIONS.AUDIT_VIEW),
  asyncHandler(async (_req, res) => {
    return sendSuccess(res, AUDIT_ACTIONS)
  }),
)
