import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import type { IsoDate } from '../../utils/dates.js'
import type { ScopeClause } from '../employees/employee-access.js'

/** One day's salary / n hours, or a custom amount per hour. */
export type OvertimeRateBasis = 'DAY_SALARY' | 'CUSTOM'

export interface OvertimeRate {
  basis: OvertimeRateBasis
  dayDivisor: number | null
  ratePerHourMinor: number | null
}

export interface OvertimeRow {
  id: string
  organization_id: string
  employee_id: string
  work_date: IsoDate
  hours: string
  remarks: string | null
  rate_basis: OvertimeRateBasis
  /** NUMERIC comes back as a string; set only for DAY_SALARY. */
  day_divisor: string | null
  /** Set only for CUSTOM. */
  rate_per_hour_minor: number | null
  locked_by_payroll_run_id: string | null
  marked_by: string | null
  created_at: Date
  updated_at: Date
}

export interface OvertimeWithEmployeeRow extends OvertimeRow {
  employee_code: string
  first_name: string
  last_name: string | null
  department_name: string | null
  overtime_handling: string
}

export async function findOvertimeById(id: string, organizationId: string, db: Queryable = pool): Promise<OvertimeRow | null> {
  return queryOne<OvertimeRow>(db, 'SELECT * FROM overtime_entries WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function findOvertimeForDate(
  employeeId: string,
  date: IsoDate,
  db: Queryable = pool,
): Promise<OvertimeRow | null> {
  return queryOne<OvertimeRow>(db, 'SELECT * FROM overtime_entries WHERE employee_id = $1 AND work_date = $2', [
    employeeId,
    date,
  ])
}

/** Every OT entry for one employee across a window - used to total a week or a payroll period. */
export async function listOvertimeForEmployee(
  employeeId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<OvertimeRow[]> {
  return queryRows<OvertimeRow>(
    db,
    'SELECT * FROM overtime_entries WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date',
    [employeeId, from, to],
  )
}

/**
 * Total OT hours for a set of employees over a window, per employee and per
 * rate the hours were recorded at, batched for payroll (plan section 59).
 */
export async function sumOvertimeHoursByRate(
  employeeIds: string[],
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<Map<string, (OvertimeRate & { hours: number })[]>> {
  const byEmployee = new Map<string, (OvertimeRate & { hours: number })[]>()
  if (employeeIds.length === 0) return byEmployee
  const rows = await queryRows<{
    employee_id: string
    rate_basis: OvertimeRateBasis
    day_divisor: string | null
    rate_per_hour_minor: number | null
    total_hours: string
  }>(
    db,
    `SELECT employee_id, rate_basis, day_divisor::text AS day_divisor, rate_per_hour_minor, sum(hours)::text AS total_hours
       FROM overtime_entries
      WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3
      GROUP BY employee_id, rate_basis, day_divisor, rate_per_hour_minor
      ORDER BY employee_id, rate_basis, day_divisor, rate_per_hour_minor`,
    [employeeIds, from, to],
  )
  for (const row of rows) {
    const list = byEmployee.get(row.employee_id) ?? []
    list.push({
      basis: row.rate_basis,
      dayDivisor: row.day_divisor === null ? null : Number(row.day_divisor),
      ratePerHourMinor: row.rate_per_hour_minor,
      hours: Number(row.total_hours),
    })
    byEmployee.set(row.employee_id, list)
  }
  return byEmployee
}

export async function listOvertime(
  scope: ScopeClause,
  filters: { from: IsoDate; to: IsoDate; employeeId?: string; departmentId?: string; supervisorId?: string },
  db: Queryable = pool,
): Promise<OvertimeWithEmployeeRow[]> {
  const params: unknown[] = [...scope.params]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const conditions = [
    `(${scope.sql})`,
    `o.work_date >= $${push(filters.from)}`,
    `o.work_date <= $${push(filters.to)}`,
  ]
  if (filters.employeeId) conditions.push(`o.employee_id = $${push(filters.employeeId)}`)
  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.supervisorId) conditions.push(`e.supervisor_id = $${push(filters.supervisorId)}`)

  return queryRows<OvertimeWithEmployeeRow>(
    db,
    `SELECT o.*, e.employee_code, e.first_name, e.last_name, d.name AS department_name,
            t.overtime_handling::text AS overtime_handling
       FROM overtime_entries o
       JOIN employees e ON e.id = o.employee_id
       JOIN employee_types t ON t.id = e.employee_type_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.work_date DESC, e.employee_code ASC`,
    params,
  )
}

export async function upsertOvertime(
  values: {
    organizationId: string
    employeeId: string
    workDate: IsoDate
    hours: number
    remarks?: string | null
    rate: OvertimeRate
    userId: string | null
  },
  db: Queryable = pool,
): Promise<OvertimeRow> {
  const row = await queryOne<OvertimeRow>(
    db,
    `INSERT INTO overtime_entries
       (organization_id, employee_id, work_date, hours, remarks, rate_basis, day_divisor, rate_per_hour_minor, marked_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (employee_id, work_date) DO UPDATE
       SET hours = EXCLUDED.hours,
           remarks = EXCLUDED.remarks,
           rate_basis = EXCLUDED.rate_basis,
           day_divisor = EXCLUDED.day_divisor,
           rate_per_hour_minor = EXCLUDED.rate_per_hour_minor,
           updated_at = now()
     RETURNING *`,
    [
      values.organizationId,
      values.employeeId,
      values.workDate,
      values.hours,
      values.remarks ?? null,
      values.rate.basis,
      values.rate.basis === 'DAY_SALARY' ? values.rate.dayDivisor : null,
      values.rate.basis === 'CUSTOM' ? values.rate.ratePerHourMinor : null,
      values.userId,
    ],
  )
  return row as OvertimeRow
}

export async function deleteOvertime(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM overtime_entries WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

/** Marks the OT consumed by a payroll run so later edits are refused, mirroring attendance. */
export async function lockOvertimeForPeriod(
  organizationId: string,
  payrollRunId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<number> {
  const result = await db.query(
    `UPDATE overtime_entries
        SET locked_by_payroll_run_id = $2
      WHERE organization_id = $1 AND work_date BETWEEN $3 AND $4`,
    [organizationId, payrollRunId, from, to],
  )
  return result.rowCount ?? 0
}

export async function unlockOvertimeForRun(payrollRunId: string, db: Queryable = pool): Promise<number> {
  const result = await db.query('UPDATE overtime_entries SET locked_by_payroll_run_id = NULL WHERE locked_by_payroll_run_id = $1', [
    payrollRunId,
  ])
  return result.rowCount ?? 0
}

/** Each employee's overtime hours in each week (Monday to Sunday), for the paid offs they earn. */
export async function sumOvertimeHoursByWeek(
  employeeIds: string[],
  db: Queryable = pool,
): Promise<{ employee_id: string; week_start: IsoDate; hours: string }[]> {
  if (employeeIds.length === 0) return []
  return queryRows(
    db,
    `SELECT employee_id, date_trunc('week', work_date)::date AS week_start, sum(hours)::text AS hours
       FROM overtime_entries
      WHERE employee_id = ANY($1::uuid[])
      GROUP BY employee_id, week_start`,
    [employeeIds],
  )
}

/**
 * The offs overtime has already been turned into: paid offs (PAID_OFF), and
 * extra weekly offs from before paid offs (OVERTIME_CONVERSION), which used up
 * the overtime that earned them all the same.
 */
export interface OvertimeOffRow {
  id: string
  employee_id: string
  off_date: IsoDate
  source: 'PAID_OFF' | 'OVERTIME_CONVERSION'
}

export async function listOvertimeOffs(employeeIds: string[], db: Queryable = pool): Promise<OvertimeOffRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<OvertimeOffRow>(
    db,
    `SELECT id, employee_id, off_date, source
       FROM employee_extra_weekly_offs
      WHERE employee_id = ANY($1::uuid[]) AND source IN ('PAID_OFF', 'OVERTIME_CONVERSION')
      ORDER BY off_date`,
    [employeeIds],
  )
}

/** Every overtime entry of these employees, latest first. */
export async function listOvertimeForEmployees(employeeIds: string[], db: Queryable = pool): Promise<OvertimeRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<OvertimeRow>(
    db,
    'SELECT * FROM overtime_entries WHERE employee_id = ANY($1::uuid[]) ORDER BY work_date DESC',
    [employeeIds],
  )
}
