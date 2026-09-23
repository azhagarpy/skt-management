import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { buildUpdate } from '../organization/organization.repository.js'
import { offsetOf, safeSort } from '../../utils/pagination.js'
import type { IsoDate } from '../../utils/dates.js'
import type { ScopeClause } from '../employees/employee-access.js'
import type { LeaveRequestListQuery } from './leave.validation.js'

export interface LeaveTypeRow {
  id: string
  organization_id: string
  name: string
  code: string
  description: string | null
  annual_limit: string | null
  is_paid: boolean
  requires_approval: boolean
  allow_half_day: boolean
  exclude_weekly_off: boolean
  exclude_holidays: boolean
  /** A holiday with leave either side of it is charged as leave too. */
  sandwich_holidays: boolean
  max_consecutive_days: number | null
  requires_attachment: boolean
  is_active: boolean
}

export interface LeavePolicyRow {
  id: string
  organization_id: string
  leave_type_id: string
  name: string
  employment_type: string | null
  department_id: string | null
  accrual_period: string
  accrual_amount: string
  opening_balance: string
  carry_forward_allowed: boolean
  max_carry_forward: string | null
  allow_negative_balance: boolean
  min_service_days: number
  effective_from: IsoDate
  effective_to: IsoDate | null
  is_active: boolean
  leave_type_name?: string
}

export interface LeaveBalanceRow {
  id: string
  employee_id: string
  leave_type_id: string
  leave_year: number
  opening_balance: string
  accrued: string
  carried_forward: string
  used: string
  pending: string
  adjustment: string
  leave_type_name?: string
  leave_type_code?: string
  is_paid?: boolean
  annual_limit?: string | null
}

export interface LeaveRequestRow {
  id: string
  organization_id: string
  employee_id: string
  leave_type_id: string
  from_date: IsoDate
  to_date: IsoDate
  day_portion: string
  total_days: string
  reason: string
  status: string
  attachment_id: string | null
  decided_by: string | null
  decided_at: Date | null
  decision_comment: string | null
  cancelled_at: Date | null
  cancellation_reason: string | null
  created_at: Date
}

export interface LeaveRequestWithDetailsRow extends LeaveRequestRow {
  employee_code: string
  first_name: string
  last_name: string | null
  department_name: string | null
  supervisor_id: string | null
  leave_type_name: string
  leave_type_code: string
  is_paid: boolean
  decided_by_name: string | null
}

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

export async function listLeaveTypes(
  organizationId: string,
  activeOnly: boolean,
  db: Queryable = pool,
): Promise<LeaveTypeRow[]> {
  const clause = activeOnly ? 'AND is_active' : ''
  return queryRows<LeaveTypeRow>(
    db,
    `SELECT * FROM leave_types WHERE organization_id = $1 ${clause} ORDER BY name`,
    [organizationId],
  )
}

export async function findLeaveType(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<LeaveTypeRow | null> {
  return queryOne<LeaveTypeRow>(db, 'SELECT * FROM leave_types WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertLeaveType(values: Record<string, unknown>, db: Queryable = pool): Promise<LeaveTypeRow> {
  const row = await queryOne<LeaveTypeRow>(
    db,
    `INSERT INTO leave_types
       (organization_id, name, code, description, annual_limit, is_paid, requires_approval, allow_half_day,
        exclude_weekly_off, exclude_holidays, sandwich_holidays, max_consecutive_days, requires_attachment,
        is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.description ?? null,
      values.annual_limit ?? null,
      values.is_paid ?? true,
      values.requires_approval ?? true,
      values.allow_half_day ?? true,
      values.exclude_weekly_off ?? true,
      values.exclude_holidays ?? true,
      values.sandwich_holidays ?? true,
      values.max_consecutive_days ?? null,
      values.requires_attachment ?? false,
      values.is_active ?? true,
    ],
  )
  return row as LeaveTypeRow
}

export async function updateLeaveType(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<LeaveTypeRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findLeaveType(id, organizationId, db)
  return queryOne<LeaveTypeRow>(
    db,
    `UPDATE leave_types SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

// ---------------------------------------------------------------------------
// Leave policies
// ---------------------------------------------------------------------------

export async function listLeavePolicies(organizationId: string, db: Queryable = pool): Promise<LeavePolicyRow[]> {
  return queryRows<LeavePolicyRow>(
    db,
    `SELECT p.*, t.name AS leave_type_name
       FROM leave_policies p
       JOIN leave_types t ON t.id = p.leave_type_id
      WHERE p.organization_id = $1
      ORDER BY t.name, p.effective_from DESC`,
    [organizationId],
  )
}

export async function insertLeavePolicy(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<LeavePolicyRow> {
  const row = await queryOne<LeavePolicyRow>(
    db,
    `INSERT INTO leave_policies
       (organization_id, leave_type_id, name, employment_type, department_id, accrual_period, accrual_amount,
        opening_balance, carry_forward_allowed, max_carry_forward, allow_negative_balance, min_service_days,
        effective_from, effective_to, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      values.organization_id,
      values.leave_type_id,
      values.name,
      values.employment_type ?? null,
      values.department_id ?? null,
      values.accrual_period,
      values.accrual_amount,
      values.opening_balance,
      values.carry_forward_allowed,
      values.max_carry_forward ?? null,
      values.allow_negative_balance,
      values.min_service_days,
      values.effective_from,
      values.effective_to ?? null,
      values.is_active,
    ],
  )
  return row as LeavePolicyRow
}

export async function updateLeavePolicy(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<LeavePolicyRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) {
    return queryOne<LeavePolicyRow>(db, 'SELECT * FROM leave_policies WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ])
  }
  return queryOne<LeavePolicyRow>(
    db,
    `UPDATE leave_policies SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

/** The policy that applies to an employee for a leave type on a date. */
export async function findApplicablePolicy(
  organizationId: string,
  leaveTypeId: string,
  employmentType: string,
  departmentId: string | null,
  onDate: IsoDate,
  db: Queryable = pool,
): Promise<LeavePolicyRow | null> {
  return queryOne<LeavePolicyRow>(
    db,
    `SELECT * FROM leave_policies
      WHERE organization_id = $1
        AND leave_type_id = $2
        AND is_active
        AND effective_from <= $5
        AND (effective_to IS NULL OR effective_to >= $5)
        AND (employment_type IS NULL OR employment_type = $3)
        AND (department_id IS NULL OR department_id = $4)
      ORDER BY (department_id IS NOT NULL)::int DESC,
               (employment_type IS NOT NULL)::int DESC,
               effective_from DESC
      LIMIT 1`,
    [organizationId, leaveTypeId, employmentType, departmentId, onDate],
  )
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export async function listBalances(
  employeeId: string,
  year: number,
  db: Queryable = pool,
): Promise<LeaveBalanceRow[]> {
  return queryRows<LeaveBalanceRow>(
    db,
    `SELECT b.*, t.name AS leave_type_name, t.code AS leave_type_code, t.is_paid, t.annual_limit
       FROM employee_leave_balances b
       JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.employee_id = $1 AND b.leave_year = $2
      ORDER BY t.name`,
    [employeeId, year],
  )
}

export async function findBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  db: Queryable = pool,
): Promise<LeaveBalanceRow | null> {
  return queryOne<LeaveBalanceRow>(
    db,
    'SELECT * FROM employee_leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3 FOR UPDATE',
    [employeeId, leaveTypeId, year],
  )
}

export async function ensureBalance(
  values: { organizationId: string; employeeId: string; leaveTypeId: string; year: number; openingBalance: number; accrued: number },
  db: Queryable = pool,
): Promise<LeaveBalanceRow> {
  const row = await queryOne<LeaveBalanceRow>(
    db,
    `INSERT INTO employee_leave_balances
       (organization_id, employee_id, leave_type_id, leave_year, opening_balance, accrued)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, leave_type_id, leave_year) DO UPDATE
       SET employee_id = EXCLUDED.employee_id
     RETURNING *`,
    [values.organizationId, values.employeeId, values.leaveTypeId, values.year, values.openingBalance, values.accrued],
  )
  return row as LeaveBalanceRow
}

/** Moves days between the pending, used and adjustment buckets atomically. */
export async function adjustBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  deltas: { pending?: number; used?: number; adjustment?: number },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE employee_leave_balances
        SET pending = GREATEST(pending + $4, 0),
            used = GREATEST(used + $5, 0),
            adjustment = adjustment + $6
      WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`,
    [employeeId, leaveTypeId, year, deltas.pending ?? 0, deltas.used ?? 0, deltas.adjustment ?? 0],
  )
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

const REQUEST_COLUMNS = `
  r.*,
  e.employee_code,
  e.first_name,
  e.last_name,
  e.supervisor_id,
  d.name AS department_name,
  t.name AS leave_type_name,
  t.code AS leave_type_code,
  t.is_paid,
  u.full_name AS decided_by_name
`

const REQUEST_JOINS = `
  FROM leave_requests r
  JOIN employees e ON e.id = r.employee_id
  JOIN leave_types t ON t.id = r.leave_type_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN users u ON u.id = r.decided_by
`

const REQUEST_SORT: Record<string, string> = {
  fromDate: 'r.from_date',
  createdAt: 'r.created_at',
  status: 'r.status',
  employeeCode: 'e.employee_code',
}

export async function listLeaveRequests(
  scope: ScopeClause,
  filters: LeaveRequestListQuery & { employeeId?: string },
  db: Queryable = pool,
): Promise<{ rows: LeaveRequestWithDetailsRow[]; total: number }> {
  const params: unknown[] = [...scope.params]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const conditions = [`(${scope.sql})`]
  if (filters.status) conditions.push(`r.status = $${push(filters.status)}`)
  if (filters.employeeId) conditions.push(`r.employee_id = $${push(filters.employeeId)}`)
  if (filters.leaveTypeId) conditions.push(`r.leave_type_id = $${push(filters.leaveTypeId)}`)
  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.from) conditions.push(`r.to_date >= $${push(filters.from)}`)
  if (filters.to) conditions.push(`r.from_date <= $${push(filters.to)}`)

  const clause = conditions.join(' AND ')
  const order = safeSort(filters.sortBy, filters.sortOrder ?? 'desc', REQUEST_SORT, 'r.created_at')

  const countRow = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count ${REQUEST_JOINS} WHERE ${clause}`,
    params,
  )

  const rows = await queryRows<LeaveRequestWithDetailsRow>(
    db,
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_JOINS}
      WHERE ${clause}
      ORDER BY ${order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
  )

  return { rows, total: Number(countRow?.count ?? 0) }
}

export async function findLeaveRequest(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<LeaveRequestWithDetailsRow | null> {
  return queryOne<LeaveRequestWithDetailsRow>(
    db,
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_JOINS} WHERE r.id = $1 AND r.organization_id = $2`,
    [id, organizationId],
  )
}

export async function insertLeaveRequest(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<LeaveRequestRow> {
  const row = await queryOne<LeaveRequestRow>(
    db,
    `INSERT INTO leave_requests
       (organization_id, employee_id, leave_type_id, from_date, to_date, day_portion, total_days,
        reason, status, attachment_id, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.leave_type_id,
      values.from_date,
      values.to_date,
      values.day_portion,
      values.total_days,
      values.reason,
      values.status,
      values.attachment_id ?? null,
      values.applied_by ?? null,
    ],
  )
  return row as LeaveRequestRow
}

export async function setLeaveRequestStatus(
  id: string,
  organizationId: string,
  values: {
    status: string
    decidedBy?: string | null
    decisionComment?: string | null
    cancellationReason?: string | null
    /** Approval recounts the days, which the sandwich rule can have changed. */
    totalDays?: number
  },
  db: Queryable = pool,
): Promise<LeaveRequestRow | null> {
  return queryOne<LeaveRequestRow>(
    db,
    `UPDATE leave_requests
        SET status = $3::leave_request_status,
            decided_by = COALESCE($4, decided_by),
            decided_at = CASE WHEN $3::text IN ('APPROVED', 'REJECTED') THEN now() ELSE decided_at END,
            decision_comment = COALESCE($5, decision_comment),
            cancelled_at = CASE WHEN $3::text = 'CANCELLED' THEN now() ELSE cancelled_at END,
            cancellation_reason = COALESCE($6, cancellation_reason),
            total_days = COALESCE($7, total_days)
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [
      id,
      organizationId,
      values.status,
      values.decidedBy ?? null,
      values.decisionComment ?? null,
      values.cancellationReason ?? null,
      values.totalDays ?? null,
    ],
  )
}

export async function insertApproval(
  values: {
    organizationId: string
    leaveRequestId: string
    approverUserId: string | null
    approverEmployeeId: string | null
    action: 'APPROVED' | 'REJECTED'
    comment: string | null
  },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO leave_approvals
       (organization_id, leave_request_id, approver_user_id, approver_employee_id, action, comment)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      values.organizationId,
      values.leaveRequestId,
      values.approverUserId,
      values.approverEmployeeId,
      values.action,
      values.comment,
    ],
  )
}

export async function listApprovals(
  leaveRequestId: string,
  db: Queryable = pool,
): Promise<{ id: string; action: string; comment: string | null; created_at: Date; approver_name: string | null }[]> {
  return queryRows(
    db,
    `SELECT a.id, a.action::text AS action, a.comment, a.created_at, u.full_name AS approver_name
       FROM leave_approvals a
       LEFT JOIN users u ON u.id = a.approver_user_id
      WHERE a.leave_request_id = $1
      ORDER BY a.created_at ASC`,
    [leaveRequestId],
  )
}

export async function countPendingRequests(scope: ScopeClause, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count
       FROM leave_requests r
       JOIN employees e ON e.id = r.employee_id
      WHERE (${scope.sql}) AND r.status = 'PENDING'`,
    scope.params,
  )
  return Number(row?.count ?? 0)
}

/** Approved leave overlapping a period, used by the payroll engine. */
export async function listApprovedLeaveForPeriod(
  employeeIds: string[],
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<
  {
    employee_id: string
    leave_type_id: string
    from_date: IsoDate
    to_date: IsoDate
    day_portion: string
    is_paid: boolean
    leave_type_name: string
    leave_type_code: string
  }[]
> {
  if (employeeIds.length === 0) return []
  return queryRows(
    db,
    `SELECT r.employee_id, r.leave_type_id, r.from_date, r.to_date, r.day_portion,
            t.is_paid, t.name AS leave_type_name, t.code AS leave_type_code
       FROM leave_requests r
       JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = ANY($1::uuid[])
        AND r.status = 'APPROVED'
        AND r.from_date <= $3
        AND r.to_date >= $2`,
    [employeeIds, from, to],
  )
}
