import { addRegisterHolidayFigures, type ReportRow } from './report-amounts.js'
import { YEARLY_PARTICULARS, yearlyMonthKey } from './report-definitions.js'

/**
 * The Yearly Salary report: each employee's payroll rows, one per month,
 * turned into a row per figure - gross, each deduction, net and the rest -
 * with the months as columns and their total. Each month's holidays and
 * Holiday Wages are worked out first, exactly as the Salary Register works
 * them out. Rows adding up every employee close the report.
 */

/** Amounts and days both have two decimal places, so they add up exactly in hundredths. */
const hundredths = (value: unknown): number => Math.round(Number(value ?? 0) * 100)

/** Each figure's value by month, in hundredths. */
type Figures = Map<string, Map<string, number>>

interface EmployeeFigures {
  employee: ReportRow
  figures: Figures
}

function emptyFigures(): Figures {
  return new Map(YEARLY_PARTICULARS.map((particular) => [particular.source, new Map()]))
}

function addMonth(figures: Figures, month: string, monthRow: ReportRow): void {
  // Total wages: every wage earned in the month, overtime included.
  const totalWages = hundredths(monthRow.gross_earnings) + hundredths(monthRow.overtime_amount)
  for (const { source } of YEARLY_PARTICULARS) {
    const value = source === 'total_wages' ? totalWages : hundredths(monthRow[source])
    const byMonth = figures.get(source) as Map<string, number>
    byMonth.set(month, (byMonth.get(month) ?? 0) + value)
  }
}

/** A row per figure: its value in each month the employee was paid, and the total. */
function figureRows(employee: ReportRow, figures: Figures): ReportRow[] {
  return YEARLY_PARTICULARS.map(({ label, source }) => {
    const row: ReportRow = { ...employee, particulars: label }
    let total = 0
    for (const [month, value] of figures.get(source) ?? []) {
      row[month] = value / 100
      total += value
    }
    row.range_total = total / 100
    return row
  })
}

export function pivotYearlySalary(rows: ReportRow[]): ReportRow[] {
  const byEmployee = new Map<string, EmployeeFigures>()
  const everyone = emptyFigures()

  for (const monthRow of rows) {
    const employeeId = String(monthRow.employee_id)
    let entry = byEmployee.get(employeeId)
    if (!entry) {
      entry = {
        employee: {
          employee_code: monthRow.employee_code,
          employee_name: monthRow.employee_name,
          department_name: monthRow.department_name,
          designation_name: monthRow.designation_name,
        },
        figures: emptyFigures(),
      }
      byEmployee.set(employeeId, entry)
    }
    const month = yearlyMonthKey(`${monthRow.run_year}-${String(monthRow.run_month).padStart(2, '0')}`)
    addMonth(entry.figures, month, monthRow)
    addMonth(everyone, month, monthRow)
  }

  const result = [...byEmployee.values()].flatMap(({ employee, figures }) => figureRows(employee, figures))
  // With more than one employee, the report ends with all of them added up.
  if (byEmployee.size > 1) {
    result.push(
      ...figureRows(
        { employee_code: 'ALL', employee_name: `All employees (${byEmployee.size})`, department_name: null, designation_name: null },
        everyone,
      ),
    )
  }
  return result
}

export async function addYearlySalary(organizationId: string, rows: ReportRow[]): Promise<ReportRow[]> {
  return pivotYearlySalary(await addRegisterHolidayFigures(organizationId, rows))
}
