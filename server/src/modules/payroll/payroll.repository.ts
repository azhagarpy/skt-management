import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { buildUpdate } from '../organization/organization.repository.js'
import { offsetOf } from '../../utils/pagination.js'
import type { IsoDate } from '../../utils/dates.js'
import type { ScopeClause } from '../employees/employee-access.js'

export type PayrollRunStatus = 'DRAFT' | 'CALCULATED' | 'UNDER_REVIEW' | 'APPROVED' | 'LOCKED'
export type PaymentStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID'

export interface PayrollRunRow {
  id: string
  organization_id: string
  year: number
  month: number
  name: string | null
  status: PayrollRunStatus
  period_start: IsoDate
  period_end: IsoDate
  total_employees: number
  total_gross: string
  total_deductions: string
  total_net: string
  total_paid: string
  total_pending: string
  notes: string | null
  created_at: Date
  calculated_at: Date | null
  approved_at: Date | null
  locked_at: Date | null
  created_by_name?: string | null
  approved_by_name?: string | null
}

export interface PayrollItemRow {
  id: string
  organization_id: string
  payroll_run_id: string
  employee_id: string
  employee_code: string
  employee_name: string
  department_name: string | null
  designation_name: string | null
  supervisor_name: string | null
  salary_basis: 'MONTHLY' | 'DAILY'
  salary_structure_id: string | null
  salary_structure_name: string | null
  salary_assignment_id: string | null
  calendar_days: string
  working_days: string
  present_days: string
  absent_days: string
  leave_days: string
  paid_leave_days: string
  unpaid_leave_days: string
  half_day_leave_days: string
  holiday_days: string
  weekly_off_days: string
  unmarked_days: string
  paid_days: string
  payable_days_basis: string
  gross_earnings: string
  total_bonus: string
  total_deductions: string
  employer_contributions: string
  pf_wage: string
  pf_wage_ceiling: string
  esi_wage: string
  net_salary: string
  paid_amount: string
  pending_amount: string
  payment_status: PaymentStatus
  remarks: string | null
  calculation_snapshot: Record<string, unknown>
  // Summed from the item's components; only the run's item list selects these.
  pf_employee?: string
  pf_employer_epf?: string
  pf_employer_eps?: string
  esi_employee?: string
  esi_employer?: string
  // Joined for run-level views.
  run_status?: PayrollRunStatus
  run_year?: number
  run_month?: number
}

export interface PayrollItemComponentRow {
  id: string
  payroll_item_id: string
  component_code: string
  component_name: string
  component_type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  calculation_type: 'FIXED' | 'PERCENTAGE'
  source: string
  full_amount: string
  amount: string
  percentage: string | null
  taxable: boolean
  display_order: number
  reference_id: string | null
  notes: string | null
}

export interface PayrollAdjustmentRow {
  id: string
  employee_id: string
  source_payroll_item_id: string | null
  adjustment_type: string
  component_code: string
  component_name: string
  component_type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  amount: string
  apply_year: number
  apply_month: number
  applied_payroll_item_id: string | null
  reason: string
  applied_at: Date | null
  employee_code?: string
  first_name?: string
  last_name?: string | null
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RUN_SELECT = `
  SELECT r.*, cu.full_name AS created_by_name, au.full_name AS approved_by_name
    FROM payroll_runs r
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users au ON au.id = r.approved_by
`

export async function listRuns(
  organizationId: string,
  filters: { year?: number; status?: string; page: number; pageSize: number },
  db: Queryable = pool,
): Promise<{ rows: PayrollRunRow[]; total: number }> {
  const conditions = ['r.organization_id = $1']
  const params: unknown[] = [organizationId]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  if (filters.year) conditions.push(`r.year = $${push(filters.year)}`)
  if (filters.status) conditions.push(`r.status = $${push(filters.status)}`)

  const clause = conditions.join(' AND ')
  const countRow = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM payroll_runs r WHERE ${clause}`,
    params,
  )

  const rows = await queryRows<PayrollRunRow>(
    db,
    `${RUN_SELECT} WHERE ${clause}
      ORDER BY r.year DESC, r.month DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
  )

  return { rows, total: Number(countRow?.count ?? 0) }
}

export async function findRun(id: string, organizationId: string, db: Queryable = pool): Promise<PayrollRunRow | null> {
  return queryOne<PayrollRunRow>(db, `${RUN_SELECT} WHERE r.id = $1 AND r.organization_id = $2`, [id, organizationId])
}

/** Locks the run row for update so two calculations cannot interleave. */
export async function findRunForUpdate(
  id: string,
  organizationId: string,
  db: Queryable,
): Promise<PayrollRunRow | null> {
  return queryOne<PayrollRunRow>(db, 'SELECT * FROM payroll_runs WHERE id = $1 AND organization_id = $2 FOR UPDATE', [
    id,
    organizationId,
  ])
}

export async function findRunByPeriod(
  organizationId: string,
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<PayrollRunRow | null> {
  return queryOne<PayrollRunRow>(
    db,
    'SELECT * FROM payroll_runs WHERE organization_id = $1 AND year = $2 AND month = $3',
    [organizationId, year, month],
  )
}

/** A run whose dates share a day with this range, other than the run being edited. */
export async function findOverlappingRun(
  organizationId: string,
  start: IsoDate,
  end: IsoDate,
  excludeRunId: string | null,
  db: Queryable = pool,
): Promise<PayrollRunRow | null> {
  return queryOne<PayrollRunRow>(
    db,
    `SELECT * FROM payroll_runs
      WHERE organization_id = $1
        AND period_start <= $3 AND period_end >= $2
        AND ($4::uuid IS NULL OR id <> $4::uuid)
      LIMIT 1`,
    [organizationId, start, end, excludeRunId],
  )
}

export async function insertRun(values: Record<string, unknown>, db: Queryable = pool): Promise<PayrollRunRow> {
  const row = await queryOne<PayrollRunRow>(
    db,
    `INSERT INTO payroll_runs
       (organization_id, year, month, name, period_start, period_end, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      values.organization_id,
      values.year,
      values.month,
      values.name ?? null,
      values.period_start,
      values.period_end,
      values.notes ?? null,
      values.created_by ?? null,
    ],
  )
  return row as PayrollRunRow
}

export async function updateRun(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<PayrollRunRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findRun(id, organizationId, db)
  return queryOne<PayrollRunRow>(
    db,
    `UPDATE payroll_runs SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

/** Recomputes the run totals from its items, so header and detail never diverge. */
export async function refreshRunTotals(runId: string, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE payroll_runs r
        SET total_employees = t.count,
            total_gross = t.gross,
            total_deductions = t.deductions,
            total_net = t.net,
            total_paid = t.paid,
            total_pending = t.pending
       FROM (
         SELECT count(*)                     AS count,
                coalesce(sum(gross_earnings), 0)   AS gross,
                coalesce(sum(total_deductions), 0) AS deductions,
                coalesce(sum(net_salary), 0)       AS net,
                coalesce(sum(paid_amount), 0)      AS paid,
                coalesce(sum(pending_amount), 0)   AS pending
           FROM payroll_items
          WHERE payroll_run_id = $1
       ) t
      WHERE r.id = $1`,
    [runId],
  )
}

export async function deleteRunItems(runId: string, db: Queryable): Promise<void> {
  await db.query('DELETE FROM payroll_items WHERE payroll_run_id = $1', [runId])
}

/** Deletes the run itself; items cascade. Returns whether a row was removed. */
export async function deleteRun(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM payroll_runs WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function insertItem(values: Record<string, unknown>, db: Queryable): Promise<PayrollItemRow> {
  const row = await queryOne<PayrollItemRow>(
    db,
    `INSERT INTO payroll_items (
       organization_id, payroll_run_id, employee_id, employee_code, employee_name,
       department_name, designation_name, supervisor_name, salary_basis,
       salary_structure_id, salary_structure_name, salary_assignment_id,
       calendar_days, working_days, present_days, absent_days, leave_days,
       paid_leave_days, unpaid_leave_days, half_day_leave_days, holiday_days,
       weekly_off_days, unmarked_days, paid_days, payable_days_basis,
       gross_earnings, total_bonus, total_deductions, employer_contributions,
       pf_wage, pf_wage_ceiling, esi_wage, net_salary,
       paid_amount, pending_amount, payment_status, remarks, calculation_snapshot
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38::jsonb
     ) RETURNING *`,
    [
      values.organization_id,
      values.payroll_run_id,
      values.employee_id,
      values.employee_code,
      values.employee_name,
      values.department_name ?? null,
      values.designation_name ?? null,
      values.supervisor_name ?? null,
      values.salary_basis,
      values.salary_structure_id ?? null,
      values.salary_structure_name ?? null,
      values.salary_assignment_id ?? null,
      values.calendar_days,
      values.working_days,
      values.present_days,
      values.absent_days,
      values.leave_days,
      values.paid_leave_days,
      values.unpaid_leave_days,
      values.half_day_leave_days,
      values.holiday_days,
      values.weekly_off_days,
      values.unmarked_days,
      values.paid_days,
      values.payable_days_basis,
      values.gross_earnings,
      values.total_bonus,
      values.total_deductions,
      values.employer_contributions,
      values.pf_wage ?? '0',
      values.pf_wage_ceiling ?? '0',
      values.esi_wage ?? '0',
      values.net_salary,
      values.paid_amount ?? '0',
      values.pending_amount,
      values.payment_status ?? 'PENDING',
      values.remarks ?? null,
      JSON.stringify(values.calculation_snapshot ?? {}),
    ],
  )
  return row as PayrollItemRow
}

export async function insertItemComponents(
  organizationId: string,
  payrollItemId: string,
  components: {
    code: string
    name: string
    componentType: string
    calculationType: string
    source: string
    fullAmount: string
    amount: string
    percentage: number | null
    taxable: boolean
    displayOrder: number
    referenceId: string | null
    notes: string | null
  }[],
  db: Queryable,
): Promise<void> {
  for (const component of components) {
    await db.query(
      `INSERT INTO payroll_item_components
         (organization_id, payroll_item_id, component_code, component_name, component_type,
          calculation_type, source, full_amount, amount, percentage, taxable, display_order, reference_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        organizationId,
        payrollItemId,
        component.code,
        component.name,
        component.componentType,
        component.calculationType,
        component.source,
        component.fullAmount,
        component.amount,
        component.percentage,
        component.taxable,
        component.displayOrder,
        component.referenceId,
        component.notes,
      ],
    )
  }
}

export async function listItems(
  runId: string,
  organizationId: string,
  filters: { search?: string; departmentId?: string; paymentStatus?: string; page: number; pageSize: number },
  db: Queryable = pool,
): Promise<{ rows: PayrollItemRow[]; total: number }> {
  const conditions = ['i.payroll_run_id = $1', 'i.organization_id = $2']
  const params: unknown[] = [runId, organizationId]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  if (filters.search) {
    const index = push(`%${filters.search}%`)
    conditions.push(`(i.employee_code ILIKE $${index} OR i.employee_name ILIKE $${index})`)
  }
  if (filters.departmentId) {
    conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  }
  if (filters.paymentStatus) conditions.push(`i.payment_status = $${push(filters.paymentStatus)}`)

  const clause = conditions.join(' AND ')

  const countRow = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM payroll_items i JOIN employees e ON e.id = i.employee_id WHERE ${clause}`,
    params,
  )

  const rows = await queryRows<PayrollItemRow>(
    db,
    `SELECT i.*,
            coalesce(c.pf_employee, 0)::text     AS pf_employee,
            coalesce(c.pf_employer_epf, 0)::text AS pf_employer_epf,
            coalesce(c.pf_employer_eps, 0)::text AS pf_employer_eps,
            coalesce(c.esi_employee, 0)::text    AS esi_employee,
            coalesce(c.esi_employer, 0)::text    AS esi_employer
       FROM payroll_items i
       JOIN employees e ON e.id = i.employee_id
       LEFT JOIN LATERAL (
         SELECT sum(amount) FILTER (WHERE component_code = 'PF_EMPLOYEE')     AS pf_employee,
                sum(amount) FILTER (WHERE component_code = 'PF_EMPLOYER_EPF') AS pf_employer_epf,
                sum(amount) FILTER (WHERE component_code = 'PF_EMPLOYER_EPS') AS pf_employer_eps,
                sum(amount) FILTER (WHERE component_code = 'ESI_EMPLOYEE')    AS esi_employee,
                sum(amount) FILTER (WHERE component_code = 'ESI_EMPLOYER')    AS esi_employer
           FROM payroll_item_components
          WHERE payroll_item_id = i.id
       ) c ON true
      WHERE ${clause}
      ORDER BY i.employee_code
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
  )

  return { rows, total: Number(countRow?.count ?? 0) }
}

export async function findItem(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<PayrollItemRow | null> {
  return queryOne<PayrollItemRow>(
    db,
    `SELECT i.*, r.status AS run_status, r.year AS run_year, r.month AS run_month
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE i.id = $1 AND i.organization_id = $2`,
    [id, organizationId],
  )
}

export async function findItemForUpdate(
  id: string,
  organizationId: string,
  db: Queryable,
): Promise<PayrollItemRow | null> {
  return queryOne<PayrollItemRow>(
    db,
    'SELECT * FROM payroll_items WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, organizationId],
  )
}

export async function listItemComponents(
  payrollItemId: string,
  db: Queryable = pool,
): Promise<PayrollItemComponentRow[]> {
  return queryRows<PayrollItemComponentRow>(
    db,
    'SELECT * FROM payroll_item_components WHERE payroll_item_id = $1 ORDER BY display_order, component_code',
    [payrollItemId],
  )
}

/** An employee's own payroll items, newest first. */
export async function listItemsForEmployee(
  employeeId: string,
  organizationId: string,
  filters: { year?: number; limit: number },
  db: Queryable = pool,
): Promise<PayrollItemRow[]> {
  const params: unknown[] = [employeeId, organizationId]
  let clause = 'i.employee_id = $1 AND i.organization_id = $2'
  if (filters.year) {
    params.push(filters.year)
    clause += ` AND r.year = $${params.length}`
  }
  params.push(filters.limit)

  return queryRows<PayrollItemRow>(
    db,
    `SELECT i.*, r.status AS run_status, r.year AS run_year, r.month AS run_month
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE ${clause}
        -- Employees only see payroll once it has been approved.
        AND r.status IN ('APPROVED', 'LOCKED')
      ORDER BY r.year DESC, r.month DESC
      LIMIT $${params.length}`,
    params,
  )
}

export async function listItemsForScope(
  scope: ScopeClause,
  runId: string,
  db: Queryable = pool,
): Promise<PayrollItemRow[]> {
  return queryRows<PayrollItemRow>(
    db,
    `SELECT i.* FROM payroll_items i
       JOIN employees e ON e.id = i.employee_id
      WHERE (${scope.sql}) AND i.payroll_run_id = $${scope.params.length + 1}
      ORDER BY i.employee_code`,
    [...scope.params, runId],
  )
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export async function listPendingAdjustments(
  organizationId: string,
  year: number,
  month: number,
  employeeIds: string[],
  db: Queryable = pool,
): Promise<PayrollAdjustmentRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<PayrollAdjustmentRow>(
    db,
    `SELECT * FROM payroll_adjustments
      WHERE organization_id = $1 AND apply_year = $2 AND apply_month = $3
        AND employee_id = ANY($4::uuid[])
        AND applied_at IS NULL`,
    [organizationId, year, month, employeeIds],
  )
}

export async function markAdjustmentsApplied(
  adjustmentIds: string[],
  payrollItemIdByAdjustment: Map<string, string>,
  db: Queryable,
): Promise<void> {
  for (const adjustmentId of adjustmentIds) {
    await db.query('UPDATE payroll_adjustments SET applied_at = now(), applied_payroll_item_id = $2 WHERE id = $1', [
      adjustmentId,
      payrollItemIdByAdjustment.get(adjustmentId) ?? null,
    ])
  }
}

export async function clearAppliedAdjustmentsForRun(runId: string, db: Queryable): Promise<void> {
  await db.query(
    `UPDATE payroll_adjustments
        SET applied_at = NULL, applied_payroll_item_id = NULL
      WHERE applied_payroll_item_id IN (SELECT id FROM payroll_items WHERE payroll_run_id = $1)`,
    [runId],
  )
}

export async function insertAdjustment(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<PayrollAdjustmentRow> {
  const row = await queryOne<PayrollAdjustmentRow>(
    db,
    `INSERT INTO payroll_adjustments
       (organization_id, employee_id, source_payroll_item_id, adjustment_type, component_code, component_name,
        component_type, amount, apply_year, apply_month, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.source_payroll_item_id ?? null,
      values.adjustment_type,
      values.component_code,
      values.component_name,
      values.component_type,
      values.amount,
      values.apply_year,
      values.apply_month,
      values.reason,
      values.created_by ?? null,
    ],
  )
  return row as PayrollAdjustmentRow
}

export async function listAdjustments(
  organizationId: string,
  filters: { employeeId?: string; year?: number; month?: number; appliedOnly?: boolean; componentCodePrefix?: string },
  db: Queryable = pool,
): Promise<PayrollAdjustmentRow[]> {
  const conditions = ['a.organization_id = $1']
  const params: unknown[] = [organizationId]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  if (filters.employeeId) conditions.push(`a.employee_id = $${push(filters.employeeId)}`)
  if (filters.year) conditions.push(`a.apply_year = $${push(filters.year)}`)
  if (filters.month) conditions.push(`a.apply_month = $${push(filters.month)}`)
  if (filters.appliedOnly === true) conditions.push('a.applied_at IS NOT NULL')
  if (filters.appliedOnly === false) conditions.push('a.applied_at IS NULL')
  if (filters.componentCodePrefix) conditions.push(`a.component_code LIKE $${push(`${filters.componentCodePrefix}%`)}`)

  return queryRows<PayrollAdjustmentRow>(
    db,
    `SELECT a.*, e.employee_code, e.first_name, e.last_name
       FROM payroll_adjustments a
       JOIN employees e ON e.id = a.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.apply_year DESC, a.apply_month DESC, a.created_at DESC`,
    params,
  )
}

export async function findAdjustment(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<PayrollAdjustmentRow | null> {
  return queryOne<PayrollAdjustmentRow>(
    db,
    `SELECT a.*, e.employee_code, e.first_name, e.last_name
       FROM payroll_adjustments a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.id = $1 AND a.organization_id = $2`,
    [id, organizationId],
  )
}

export async function deleteAdjustment(id: string, organizationId: string, db: Queryable = pool): Promise<void> {
  await db.query('DELETE FROM payroll_adjustments WHERE id = $1 AND organization_id = $2', [id, organizationId])
}

// ---------------------------------------------------------------------------
// Employees eligible for a payroll period
// ---------------------------------------------------------------------------

export interface PayrollEmployeeRow {
  id: string
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  department_id: string | null
  department_name: string | null
  designation_name: string | null
  location_id: string | null
  supervisor_name: string | null
  salary_basis: 'MONTHLY' | 'DAILY'
  joining_date: IsoDate
  exit_date: IsoDate | null
  employment_status: string
  pf_applicable: boolean | null
  esi_applicable: boolean | null
  overtime_handling: string
  overtime_rate_override_minor: number | null
}

/**
 * Everyone who was employed for at least part of the period.
 *
 * A leaver is included when their exit date falls inside the month, so their
 * final part-month is paid; someone who left earlier is excluded entirely.
 */
export async function listEmployeesForPeriod(
  organizationId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  db: Queryable = pool,
): Promise<PayrollEmployeeRow[]> {
  return queryRows<PayrollEmployeeRow>(
    db,
    `SELECT e.id,
            e.employee_code,
            e.first_name,
            e.middle_name,
            e.last_name,
            e.department_id,
            d.name AS department_name,
            g.name AS designation_name,
            e.location_id,
            CASE WHEN s.id IS NULL THEN NULL
                 ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name,
            e.salary_basis,
            e.joining_date,
            e.exit_date,
            e.employment_status::text AS employment_status,
            t.overtime_handling::text AS overtime_handling,
            e.overtime_rate_override_minor,
            pf.pf_applicable,
            esi.esi_applicable
       FROM employees e
       JOIN employee_types t ON t.id = e.employee_type_id
       LEFT JOIN departments  d ON d.id = e.department_id
       LEFT JOIN designations g ON g.id = e.designation_id
       LEFT JOIN employees    s ON s.id = e.supervisor_id
       LEFT JOIN employee_pf_details  pf  ON pf.employee_id = e.id
       LEFT JOIN employee_esi_details esi ON esi.employee_id = e.id
      WHERE e.organization_id = $1
        AND e.joining_date <= $3
        AND (e.exit_date IS NULL OR e.exit_date >= $2)
        AND e.employment_status <> 'INACTIVE'
      ORDER BY e.employee_code`,
    [organizationId, periodStart, periodEnd],
  )
}
