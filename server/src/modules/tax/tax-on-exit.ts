import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { ApiError } from '../../utils/api-error.js'
import {
  lastDayOfMonth,
  payCycleContaining,
  PAYROLL_CYCLE_CUTOFF_DAY,
  type IsoDate,
} from '../../utils/dates.js'
import { buildStatement, type StatementMonth } from '../bonuses/bonus-statement.js'
import { halfYearFor } from './tax-instalments.js'
import { loadSlabs, taxFor } from './tax-report.js'

/**
 * P.Tax taken from a leaver's final salary.
 *
 * P.Tax is the slab for a half-year's wages, deducted once the half-year has
 * ended (tax.module.ts). Someone who leaves during it is no longer on the
 * payroll by then, so when an employee is marked as having left, the
 * administrator can have the half-year's tax deducted from their final salary
 * instead: a tax_deductions row with on_exit set, in the payroll month that
 * holds the exit date.
 *
 * The amount depends on that final month's wages, so payroll works it out when
 * it calculates the month (calculatePayrollItem) and records it back here. What
 * is shown before then is an estimate from the months already calculated.
 */

export interface ExitTaxMonth extends StatementMonth {
  wages: number
}

export interface ExitTaxPreview {
  employeeId: string
  employeeName: string
  employmentStatus: string
  exitDate: IsoDate
  /** The payroll month holding the exit date - the employee's last. */
  payrollYear: number
  payrollMonth: number
  /** That month's payroll run status, or null when it has not been created. */
  payrollStatus: string | null
  /** False once that payroll is approved or locked. */
  payrollOpen: boolean
  /** The half-year's start to the end of the final month. */
  periodFrom: IsoDate
  periodTo: IsoDate
  /** Each month of the half-year up to the final one, with the wages payroll has calculated so far. */
  months: ExitTaxMonth[]
  wagesSoFar: number
  /** The tax on `wagesSoFar` - payroll works it out again with the final month's wages. */
  taxSoFar: number
  /** The deduction already set for this exit, if there is one. */
  existing: { id: string; wageBase: number; taxAmount: number } | null
}

/**
 * The payroll month an exit date falls in: the run whose dates hold it, or the
 * standard cycle that would. A leaver is paid in that run and in none after it
 * (listEmployeesForPeriod), so it is their final salary.
 */
export async function exitPayrollMonth(
  organizationId: string,
  exitDate: IsoDate,
  db: Queryable = pool,
): Promise<{ year: number; month: number }> {
  const run = await queryOne<{ year: number; month: number }>(
    db,
    `SELECT year, month FROM payroll_runs
      WHERE organization_id = $1 AND period_start <= $2 AND period_end >= $2
      LIMIT 1`,
    [organizationId, exitDate],
  )
  if (run) return run
  const cycle = payCycleContaining(exitDate, PAYROLL_CYCLE_CUTOFF_DAY)
  return { year: cycle.year, month: cycle.month }
}

/** The P.Tax on exit an employee would have, for the administrator to confirm. */
export async function buildExitTaxPreview(
  organizationId: string,
  employeeId: string,
  db: Queryable = pool,
): Promise<ExitTaxPreview> {
  const employee = await queryOne<{ id: string; name: string; employment_status: string; exit_date: IsoDate | null }>(
    db,
    `SELECT id, trim(first_name || ' ' || coalesce(last_name, '')) AS name,
            employment_status::text AS employment_status, exit_date
       FROM employees WHERE id = $1 AND organization_id = $2`,
    [employeeId, organizationId],
  )
  if (!employee) throw ApiError.notFound('Employee')
  if (!employee.exit_date) {
    throw ApiError.businessRule('Enter the exit date first - P.Tax on exit comes out of the final salary.')
  }

  const { year, month } = await exitPayrollMonth(organizationId, employee.exit_date, db)
  const half = halfYearFor(year, month)
  const first = half.months[0]!

  const [statement, slabs, run, existing] = await Promise.all([
    buildStatement(
      { organizationId, employeeIds: [employeeId] },
      { fromYear: first.year, fromMonth: first.month, toYear: year, toMonth: month, percentage: 1, minManDays: 0 },
      db,
    ),
    loadSlabs(organizationId, db),
    queryOne<{ status: string }>(
      db,
      'SELECT status::text AS status FROM payroll_runs WHERE organization_id = $1 AND year = $2 AND month = $3',
      [organizationId, year, month],
    ),
    queryOne<{ id: string; wage_base: string; tax_amount: string }>(
      db,
      `SELECT id, wage_base, tax_amount FROM tax_deductions
        WHERE employee_id = $1 AND payroll_year = $2 AND payroll_month = $3 AND on_exit`,
      [employeeId, year, month],
    ),
  ])

  const row = statement.rows[0]
  const months = statement.months.map((entry, position) => ({ ...entry, wages: row?.months[position]?.wages ?? 0 }))
  const wagesSoFar = row?.totalWages ?? 0
  const payrollStatus = run?.status ?? null

  return {
    employeeId,
    employeeName: employee.name,
    employmentStatus: employee.employment_status,
    exitDate: employee.exit_date,
    payrollYear: year,
    payrollMonth: month,
    payrollStatus,
    payrollOpen: payrollStatus !== 'APPROVED' && payrollStatus !== 'LOCKED',
    periodFrom: half.from,
    periodTo: lastDayOfMonth(year, month),
    months,
    wagesSoFar,
    taxSoFar: taxFor(wagesSoFar, slabs),
    existing: existing
      ? { id: existing.id, wageBase: Number(existing.wage_base), taxAmount: Number(existing.tax_amount) }
      : null,
  }
}

/**
 * Each employee's wages over the half-year's months before this one, for
 * payroll to add this month's to. Employees with no earlier payroll in the
 * half-year are left out (their earlier wages are nothing).
 */
export async function priorHalfYearWages(
  organizationId: string,
  employeeIds: string[],
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<Map<string, number>> {
  const half = halfYearFor(year, month)
  const position = half.months.findIndex((entry) => entry.year === year && entry.month === month)
  const first = half.months[0]
  const previous = half.months[position - 1]
  if (employeeIds.length === 0 || position <= 0 || !first || !previous) return new Map()

  const statement = await buildStatement(
    { organizationId, employeeIds },
    {
      fromYear: first.year,
      fromMonth: first.month,
      toYear: previous.year,
      toMonth: previous.month,
      percentage: 1,
      minManDays: 0,
    },
    db,
  )
  return new Map(statement.rows.map((row) => [row.employeeId, row.totalWages]))
}

/** Records what payroll worked the tax on exit out to, so the deduction shows the figure deducted. */
export async function recordExitTaxCalculated(
  id: string,
  wageBase: string,
  taxAmount: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query('UPDATE tax_deductions SET wage_base = $2, tax_amount = $3 WHERE id = $1', [id, wageBase, taxAmount])
}

/**
 * Withdraws an employee's tax on exit set in any month but `keep`, so it is
 * only ever taken from what is now their final salary. A month whose payroll is
 * approved or locked keeps its row: that deduction has been made.
 *
 * `keep` null withdraws them all - the employee is no longer leaving.
 */
export async function withdrawExitTax(
  organizationId: string,
  employeeId: string,
  keep: { year: number; month: number } | null,
  db: Queryable = pool,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    db,
    `DELETE FROM tax_deductions t
      WHERE t.organization_id = $1 AND t.employee_id = $2 AND t.on_exit
        AND ($3::int IS NULL OR (t.payroll_year, t.payroll_month) <> ($3::int, $4::int))
        AND NOT EXISTS (
          SELECT 1 FROM payroll_runs r
           WHERE r.organization_id = t.organization_id
             AND r.year = t.payroll_year AND r.month = t.payroll_month
             AND r.status IN ('APPROVED', 'LOCKED'))
      RETURNING t.id`,
    [organizationId, employeeId, keep?.year ?? null, keep?.month ?? null],
  )
  return rows.length
}
