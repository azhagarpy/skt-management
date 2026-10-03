import { addRegisterHolidayFigures, type ReportRow } from './report-amounts.js'
import { YEARLY_MONTH_FIELDS, yearlyMonthKey } from './report-definitions.js'

/**
 * The Yearly Salary report: each employee's payroll rows, one per month, turned
 * into one row with each month's figures side by side and the totals over the
 * range. Each month's holidays and Holiday Wages are worked out first, exactly
 * as the Salary Register works them out.
 */

/** The totals over the range: every category, and the holiday figures. */
const TOTAL_FIELDS = [
  'eligible_holidays',
  'holiday_wages',
  'gross_earnings',
  'pf_employee',
  'esi_employee',
  'ptax',
  'lwf',
  'other_deductions',
  'total_deductions',
  'overtime_amount',
  'total_wages',
  'total_credits',
  'net_salary',
]

/** Amounts and days both have two decimal places, so they add up exactly in hundredths. */
const hundredths = (value: unknown): number => Math.round(Number(value ?? 0) * 100)

/** One row per employee from their rows per month, in the order the employees first appear. */
export function pivotYearlySalary(rows: ReportRow[]): ReportRow[] {
  const byEmployee = new Map<string, { row: ReportRow; sums: Map<string, number> }>()

  for (const monthRow of rows) {
    const employeeId = String(monthRow.employee_id)
    let entry = byEmployee.get(employeeId)
    if (!entry) {
      entry = {
        row: {
          employee_code: monthRow.employee_code,
          employee_name: monthRow.employee_name,
          department_name: monthRow.department_name,
          designation_name: monthRow.designation_name,
          months: 0,
        },
        sums: new Map(TOTAL_FIELDS.map((field) => [field, 0])),
      }
      byEmployee.set(employeeId, entry)
    }

    // Total wages: every wage earned in the month, overtime included.
    const values: Record<string, number> = { total_wages: hundredths(monthRow.gross_earnings) + hundredths(monthRow.overtime_amount) }
    for (const field of TOTAL_FIELDS) values[field] ??= hundredths(monthRow[field])

    const month = yearlyMonthKey(`${monthRow.run_year}-${String(monthRow.run_month).padStart(2, '0')}`)
    for (const field of YEARLY_MONTH_FIELDS) {
      const key = `${month}_${field.suffix}`
      entry.row[key] = (hundredths(entry.row[key]) + (values[field.source] ?? 0)) / 100
    }
    for (const field of TOTAL_FIELDS) entry.sums.set(field, (entry.sums.get(field) ?? 0) + (values[field] ?? 0))
    entry.row.months = Number(entry.row.months) + 1
  }

  return [...byEmployee.values()].map(({ row, sums }) => {
    for (const [field, sum] of sums) row[field] = sum / 100
    return row
  })
}

export async function addYearlySalary(organizationId: string, rows: ReportRow[]): Promise<ReportRow[]> {
  return pivotYearlySalary(await addRegisterHolidayFigures(organizationId, rows))
}
