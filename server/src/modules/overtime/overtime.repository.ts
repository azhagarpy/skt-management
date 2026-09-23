import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import type { IsoDate } from '../../utils/dates.js'
import type { ScopeClause } from '../employees/employee-access.js'

export interface OvertimeRow {
  id: string
  organization_id: string
  employee_id: string
  work_date: IsoDate
  hours: string
  remarks: string | null
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

/** Total OT hours for a set of employees over a window, batched for payroll (plan section 59). */
export async function sumOvertimeHours(
  employeeIds: string[],
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await queryRows<{ employee_id: string; total_hours: string }>(
    db,
    `SELECT employee_id, sum(hours)::text AS total_hours
       FROM overtime_entries
      WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3
      GROUP BY employee_id`,
    [employeeIds, from, to],
  )
  return new Map(rows.map((row) => [row.employee_id, Number(row.total_hours)]))
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
    `SELECT o.*, e.employee_code, e.first_name, e.last_name, d.name AS department_name
       FROM overtime_entries o
       JOIN employees e ON e.id = o.employee_id
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
    userId: string | null
  },
  db: Queryable = pool,
): Promise<OvertimeRow> {
  const row = await queryOne<OvertimeRow>(
    db,
    `INSERT INTO overtime_entries (organization_id, employee_id, work_date, hours, remarks, marked_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (employee_id, work_date) DO UPDATE
       SET hours = EXCLUDED.hours,
           remarks = EXCLUDED.remarks,
           updated_at = now()
     RETURNING *`,
    [values.organizationId, values.employeeId, values.workDate, values.hours, values.remarks ?? null, values.userId],
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
