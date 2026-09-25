import type { Request } from 'express'
import { pool, type Queryable } from '../../database/pool.js'
import { logger } from '../../utils/logger.js'

/**
 * Audit actions (plan section 40). Kept as a closed union so a typo cannot
 * silently create an unsearchable action name.
 */
export const AUDIT_ACTIONS = [
  'USER_LOGIN',
  'USER_LOGIN_FAILED',
  'USER_LOGOUT',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_PASSWORD_CHANGED',
  'USER_PASSWORD_RESET',
  'USER_PERMISSIONS_CHANGED',
  'ORGANIZATION_UPDATED',
  'ORGANIZATION_LOGO_UPDATED',
  'ORGANIZATION_LOGO_REMOVED',
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'DEPARTMENT_DELETED',
  'EMPLOYEE_TYPE_CREATED',
  'EMPLOYEE_TYPE_UPDATED',
  'EMPLOYEE_TYPE_DELETED',
  'DESIGNATION_CREATED',
  'DESIGNATION_UPDATED',
  'DESIGNATION_DELETED',
  'LOCATION_CREATED',
  'LOCATION_UPDATED',
  'LOCATION_DELETED',
  'EMPLOYEE_CREATED',
  'EMPLOYEE_UPDATED',
  'EMPLOYEE_DELETED',
  'EMPLOYEE_STATUS_CHANGED',
  'EMPLOYEE_PHOTO_UPDATED',
  'EMPLOYEE_PHOTO_REMOVED',
  'SUPERVISOR_ASSIGNED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_VERIFIED',
  'DOCUMENT_REJECTED',
  'DOCUMENT_DELETED',
  'DOCUMENT_DOWNLOADED',
  'PAN_UPDATED',
  'AADHAAR_UPDATED',
  'BANK_ACCOUNT_UPDATED',
  'PF_UPDATED',
  'ESI_UPDATED',
  'SENSITIVE_DATA_VIEWED',
  'ATTENDANCE_MARKED',
  'ATTENDANCE_CHANGED',
  'ATTENDANCE_BULK_MARKED',
  'ATTENDANCE_IMPORTED',
  'NOC_GENERATED',
  'APPOINTMENT_LETTER_GENERATED',
  'OVERTIME_RECORDED',
  'OVERTIME_CHANGED',
  'LEAVE_REQUESTED',
  'LEAVE_APPROVED',
  'LEAVE_REJECTED',
  'LEAVE_CANCELLED',
  'LEAVE_TYPE_CREATED',
  'LEAVE_TYPE_UPDATED',
  'LEAVE_POLICY_UPDATED',
  'LEAVE_BALANCE_ADJUSTED',
  'HOLIDAY_CREATED',
  'HOLIDAY_UPDATED',
  'HOLIDAY_DELETED',
  'WEEKLY_OFF_UPDATED',
  'SALARY_STRUCTURE_CREATED',
  'SALARY_STRUCTURE_UPDATED',
  'SALARY_COMPONENT_DELETED',
  'SALARY_ASSIGNED',
  'SALARY_CHANGED',
  'STATUTORY_CONFIG_UPDATED',
  'PAYROLL_POLICY_UPDATED',
  'BONUS_ADDED',
  'BONUS_UPDATED',
  'BONUS_DELETED',
  'TAX_SLABS_UPDATED',
  'TAX_DEDUCTION_SET',
  'TAX_DEDUCTION_REMOVED',
  'LWF_GENERATED',
  'LWF_MARKED_PAID',
  'LWF_DELETED',
  'PL_WAGES_GENERATED',
  'PL_WAGES_APPROVED',
  'PL_WAGES_MARKED_PAID',
  'PL_WAGES_MARKED_UNPAID',
  'PL_WAGES_DELETED',
  'PAYROLL_RUN_CREATED',
  'PAYROLL_RUN_UPDATED',
  'PAYROLL_RUN_DELETED',
  'PAYROLL_CALCULATED',
  'PAYROLL_SUBMITTED_FOR_REVIEW',
  'PAYROLL_APPROVED',
  'PAYROLL_LOCKED',
  'PAYROLL_ADJUSTMENT_CREATED',
  'PAYROLL_ADJUSTMENT_DELETED',
  'PAYMENT_ADDED',
  'PAYMENT_UPDATED',
  'PAYMENT_REVERSED',
  'PAYSLIP_GENERATED',
  'PAYSLIP_DOWNLOADED',
  'PAYSLIP_SENT_WHATSAPP',
  'REPORT_EXPORTED',
  'SETTINGS_UPDATED',
  'MESSAGE_SCENARIO_UPDATED',
  'MESSAGE_BROADCAST_SENT',
  'PAYMENT_PROOF_UPLOADED',
  'PAYMENT_PROOF_REMOVED',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditContext {
  organizationId: string | null
  userId: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

export interface AuditEntry extends AuditContext {
  action: AuditAction
  entityType: string
  entityId?: string | null
  oldValues?: unknown
  newValues?: unknown
}

/** Fields that must never be written into the audit trail in plain form. */
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'token_hash',
  'refreshToken',
  'aadhaar_number',
  'aadhaarNumber',
  'pan_number',
  'panNumber',
  'account_number',
  'accountNumber',
])

/** Recursively replaces sensitive values with a marker before persisting. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1))
  if (typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : redact(entry, depth + 1)
  }
  return output
}

/**
 * Writes one audit row.
 *
 * Pass the surrounding transaction as `db` when the audited change is part of a
 * transaction, so the log commits or rolls back with it. Auditing never throws:
 * a logging failure must not roll back a legitimate business operation, so it is
 * reported to the application log instead.
 */
export async function recordAudit(entry: AuditEntry, db: Queryable = pool): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs
         (organization_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.organizationId,
        entry.userId,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.oldValues === undefined ? null : JSON.stringify(redact(entry.oldValues)),
        entry.newValues === undefined ? null : JSON.stringify(redact(entry.newValues)),
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ],
    )
  } catch (error) {
    logger.error({ err: error, action: entry.action, entityType: entry.entityType }, 'Failed to write audit log')
  }
}

/** Extracts the audit context (actor, IP, user agent) from a request. */
export function auditContextFrom(req: Request): AuditContext {
  return {
    organizationId: req.auth?.organizationId ?? null,
    userId: req.auth?.userId ?? null,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  }
}

/** Convenience wrapper that combines request context with an entry. */
export async function auditFromRequest(
  req: Request,
  entry: Omit<AuditEntry, keyof AuditContext>,
  db: Queryable = pool,
): Promise<void> {
  await recordAudit({ ...auditContextFrom(req), ...entry }, db)
}

/** Returns only the keys whose value actually changed, for a compact audit diff. */
export function diffValues<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { old: Partial<T>; new: Partial<T> } {
  const oldValues: Partial<T> = {}
  const newValues: Partial<T> = {}
  for (const key of Object.keys(after) as (keyof T)[]) {
    const nextValue = after[key]
    if (nextValue === undefined) continue
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(nextValue ?? null)) {
      oldValues[key] = before[key]
      newValues[key] = nextValue as T[keyof T]
    }
  }
  return { old: oldValues, new: newValues }
}
