import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { logger } from '../../utils/logger.js'
import { ApiError } from '../../utils/api-error.js'
import { buildPaginated, offsetOf, type Paginated } from '../../utils/pagination.js'
import { dispatchScenario } from '../messaging/messaging.service.js'

export type NotificationType =
  | 'LEAVE_REQUEST_SUBMITTED'
  | 'LEAVE_REQUEST_APPROVED'
  | 'LEAVE_REQUEST_REJECTED'
  | 'LEAVE_REQUEST_CANCELLED'
  | 'DOCUMENT_VERIFIED'
  | 'DOCUMENT_REJECTED'
  | 'DOCUMENT_UPLOADED'
  | 'PAYROLL_APPROVED'
  | 'PAYROLL_LOCKED'
  | 'PAYSLIP_AVAILABLE'
  | 'PAYMENT_RECORDED'
  | 'PROFILE_INCOMPLETE'
  | 'ABSENCE_STREAK'
  | 'GENERAL'

export interface NotificationInput {
  organizationId: string
  type: NotificationType
  title: string
  body: string
  link?: string | null
  metadata?: Record<string, unknown>
}

export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  metadata: Record<string, unknown>
  read_at: Date | null
  created_at: Date
}

function present(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    metadata: row.metadata,
    isRead: row.read_at !== null,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

/**
 * Sends a notification to a specific user.
 *
 * Delivery failures never propagate: a notification is a courtesy, and losing
 * one must not roll back the business operation that triggered it.
 */
export async function notifyUser(
  userId: string,
  input: NotificationInput,
  db: Queryable = pool,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO notifications (organization_id, user_id, type, title, body, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.organizationId,
        userId,
        input.type,
        input.title,
        input.body,
        input.link ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
  } catch (error) {
    logger.error({ err: error, userId, type: input.type }, 'Failed to create notification')
  }

  // Every notification path funnels through here, so the WhatsApp side is
  // wired once rather than at each of the call sites that raise an event.
  // It resolves its own scenario and stays silent when that scenario is off.
  await dispatchScenario({
    organizationId: input.organizationId,
    eventKey: input.type,
    userId,
    title: input.title,
    body: input.body,
  })
}

/** Sends to the user account linked to an employee, if there is one. */
export async function notifyUserForEmployee(
  employeeId: string,
  input: NotificationInput,
  db: Queryable = pool,
): Promise<void> {
  try {
    const row = await queryOne<{ user_id: string | null }>(db, 'SELECT user_id FROM employees WHERE id = $1', [
      employeeId,
    ])
    if (!row?.user_id) return
    await notifyUser(row.user_id, input, db)
  } catch (error) {
    logger.error({ err: error, employeeId, type: input.type }, 'Failed to resolve notification recipient')
  }
}

/** Sends to every user holding one of the given roles in an organization. */
export async function notifyRole(
  organizationId: string,
  roles: ('SUPER_ADMIN' | 'SUPERVISOR' | 'EMPLOYEE')[],
  input: NotificationInput,
  db: Queryable = pool,
): Promise<void> {
  try {
    const rows = await queryRows<{ id: string }>(
      db,
      "SELECT id FROM users WHERE organization_id = $1 AND role = ANY($2::user_role[]) AND status = 'ACTIVE'",
      [organizationId, roles],
    )
    for (const row of rows) {
      await notifyUser(row.id, input, db)
    }
  } catch (error) {
    logger.error({ err: error, organizationId, type: input.type }, 'Failed to notify role')
  }
}

export async function listNotifications(
  userId: string,
  filters: { page: number; pageSize: number; unreadOnly?: boolean },
): Promise<Paginated<ReturnType<typeof present>>> {
  const conditions = ['user_id = $1']
  const params: unknown[] = [userId]
  if (filters.unreadOnly) conditions.push('read_at IS NULL')

  const countRow = await queryOne<{ count: string }>(
    pool,
    `SELECT count(*)::text AS count FROM notifications WHERE ${conditions.join(' AND ')}`,
    params,
  )

  const rows = await queryRows<NotificationRow>(
    pool,
    `SELECT id, type, title, body, link, metadata, read_at, created_at
       FROM notifications
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
  )

  return buildPaginated(rows.map(present), Number(countRow?.count ?? 0), filters.page, filters.pageSize)
}

export async function countUnread(userId: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  )
  return Number(row?.count ?? 0)
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  const result = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [notificationId, userId],
  )
  if ((result.rowCount ?? 0) === 0) {
    // Either it does not exist, belongs to someone else, or was already read.
    const exists = await queryOne<{ id: string }>(pool, 'SELECT id FROM notifications WHERE id = $1 AND user_id = $2', [
      notificationId,
      userId,
    ])
    if (!exists) throw ApiError.notFound('Notification')
  }
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [
    userId,
  ])
  return result.rowCount ?? 0
}
