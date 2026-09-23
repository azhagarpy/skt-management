import ExcelJS from 'exceljs'
import { z } from 'zod'
import { pool, queryRows, type Queryable } from '../../database/pool.js'

/**
 * The bonus statement: what each employee earned month by month over a range,
 * and the bonus a percentage of it comes to.
 *
 * It is calculated live from payroll rather than stored, so it can be reviewed
 * (and exported) before any bonus is created, and creating a range-based bonus
 * uses exactly the same numbers.
 *
 *   man days  present days, with a half-day leave counting as half a day
 *   wages     the salary-structure earnings that landed on the payslip - not
 *             bonuses, overtime, adjustments or employer contributions, so a
 *             bonus is never worked out on top of a bonus
 *   bonus     total wages x percentage, rounded to whole rupees
 *   eligible  worked at least the minimum man days over the whole range
 */

/** Payroll months are counted as year * 12 + month so a range is one comparison. */
const monthIndex = (year: number, month: number): number => year * 12 + (month - 1)

export const MAX_STATEMENT_MONTHS = 24

export const statementQuerySchema = z
  .object({
    fromYear: z.coerce.number().int().min(1970).max(2200),
    fromMonth: z.coerce.number().int().min(1).max(12),
    toYear: z.coerce.number().int().min(1970).max(2200),
    toMonth: z.coerce.number().int().min(1).max(12),
    percentage: z.coerce.number().gt(0, 'Enter a percentage greater than zero').max(100).default(8.33),
    minManDays: z.coerce.number().min(0).max(366).default(30),
    departmentId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const from = monthIndex(value.fromYear, value.fromMonth)
    const to = monthIndex(value.toYear, value.toMonth)
    if (to < from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toMonth'], message: 'The end month is before the start month' })
    } else if (to - from + 1 > MAX_STATEMENT_MONTHS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toMonth'],
        message: `Choose a range of ${MAX_STATEMENT_MONTHS} months or fewer`,
      })
    }
  })

export type StatementQuery = z.infer<typeof statementQuerySchema>

export interface StatementMonth {
  year: number
  month: number
  label: string
  /** Null when there is no payroll run for that month. */
  runStatus: string | null
}

export interface StatementRow {
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentName: string | null
  sectionName: string | null
  /** One entry per month in `months`, in the same order. */
  months: { manDays: number; wages: number }[]
  totalManDays: number
  totalWages: number
  eligible: boolean
  /** Whole rupees; zero when not eligible. */
  bonus: number
}

export interface StatementSummaryRow {
  departmentName: string
  employees: number
  manDays: number
  bonus: number
}

export interface Statement {
  query: StatementQuery
  months: StatementMonth[]
  rows: StatementRow[]
  summary: StatementSummaryRow[]
  totals: { employees: number; manDays: number; wages: number; bonus: number }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortLabel = (year: number, month: number): string => `${SHORT_MONTHS[month - 1]} ${year}`

const round2 = (value: number): number => Math.round(value * 100) / 100

export interface StatementScope {
  organizationId: string
  /** Limit to these employees (used when creating a bonus for a chosen few). */
  employeeIds?: string[]
}

export interface PayrollLine {
  employee_id: string
  employee_code: string
  employee_name: string
  department_name: string | null
  section_name: string | null
  year: number
  month: number
  man_days: string
  wages: string
}

export async function buildStatement(
  scope: StatementScope,
  query: StatementQuery,
  db: Queryable = pool,
): Promise<Statement> {
  const from = monthIndex(query.fromYear, query.fromMonth)
  const to = monthIndex(query.toYear, query.toMonth)

  const params: unknown[] = [scope.organizationId, from, to]
  const conditions = [
    'r.organization_id = $1',
    '(r.year * 12 + r.month - 1) BETWEEN $2 AND $3',
  ]
  if (query.departmentId) {
    params.push(query.departmentId)
    conditions.push(`e.department_id = $${params.length}`)
  }
  if (scope.employeeIds) {
    params.push(scope.employeeIds)
    conditions.push(`e.id = ANY($${params.length}::uuid[])`)
  }

  const lines = await queryRows<PayrollLine>(
    db,
    `SELECT e.id AS employee_id,
            e.employee_code,
            trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
            d.name AS department_name,
            g.name AS section_name,
            r.year,
            r.month,
            (i.present_days + i.half_day_leave_days * 0.5) AS man_days,
            coalesce((SELECT sum(c.amount) FROM payroll_item_components c
                       WHERE c.payroll_item_id = i.id
                         AND c.component_type = 'EARNING'
                         AND c.source = 'SALARY_STRUCTURE'), 0) AS wages
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
       JOIN employees e ON e.id = i.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations g ON g.id = e.designation_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.employee_code`,
    params,
  )

  const runs = await queryRows<{ year: number; month: number; status: string }>(
    db,
    `SELECT year, month, status::text AS status FROM payroll_runs
      WHERE organization_id = $1 AND (year * 12 + month - 1) BETWEEN $2 AND $3`,
    [scope.organizationId, from, to],
  )

  return assembleStatement(lines, runs, query)
}

/** The arithmetic of the statement, apart from where the payroll lines come from. */
export function assembleStatement(
  lines: PayrollLine[],
  runs: { year: number; month: number; status: string }[],
  query: StatementQuery,
): Statement {
  const from = monthIndex(query.fromYear, query.fromMonth)
  const to = monthIndex(query.toYear, query.toMonth)
  const statusByMonth = new Map(runs.map((run) => [monthIndex(run.year, run.month), run.status]))


  const months: StatementMonth[] = []
  for (let index = from; index <= to; index += 1) {
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    months.push({ year, month, label: shortLabel(year, month), runStatus: statusByMonth.get(index) ?? null })
  }
  const columnOf = new Map(months.map((entry, position) => [monthIndex(entry.year, entry.month), position]))

  const byEmployee = new Map<string, StatementRow>()
  for (const line of lines) {
    let row = byEmployee.get(line.employee_id)
    if (!row) {
      row = {
        employeeId: line.employee_id,
        employeeCode: line.employee_code,
        employeeName: line.employee_name,
        departmentName: line.department_name,
        sectionName: line.section_name,
        months: months.map(() => ({ manDays: 0, wages: 0 })),
        totalManDays: 0,
        totalWages: 0,
        eligible: false,
        bonus: 0,
      }
      byEmployee.set(line.employee_id, row)
    }
    const column = columnOf.get(monthIndex(line.year, line.month))
    if (column === undefined) continue
    const cell = row.months[column]
    if (cell) {
      cell.manDays = round2(cell.manDays + Number(line.man_days))
      cell.wages = round2(cell.wages + Number(line.wages))
    }
  }

  const rows = [...byEmployee.values()]
  for (const row of rows) {
    row.totalManDays = round2(row.months.reduce((sum, cell) => sum + cell.manDays, 0))
    row.totalWages = round2(row.months.reduce((sum, cell) => sum + cell.wages, 0))
    row.eligible = row.totalManDays >= query.minManDays && row.totalWages > 0
    row.bonus = row.eligible ? Math.round((row.totalWages * query.percentage) / 100) : 0
  }

  // The summary only counts people who are eligible: someone below the minimum
  // gets no bonus, so counting them would overstate the head-count.
  const summaryMap = new Map<string, StatementSummaryRow>()
  for (const row of rows) {
    if (!row.eligible) continue
    const name = row.departmentName ?? 'No department'
    const entry = summaryMap.get(name) ?? { departmentName: name, employees: 0, manDays: 0, bonus: 0 }
    entry.employees += 1
    entry.manDays = round2(entry.manDays + row.totalManDays)
    entry.bonus += row.bonus
    summaryMap.set(name, entry)
  }
  const summary = [...summaryMap.values()].sort((a, b) => a.departmentName.localeCompare(b.departmentName))

  const eligibleRows = rows.filter((row) => row.eligible)
  return {
    query,
    months,
    rows,
    summary,
    totals: {
      employees: eligibleRows.length,
      manDays: round2(eligibleRows.reduce((sum, row) => sum + row.totalManDays, 0)),
      wages: round2(eligibleRows.reduce((sum, row) => sum + row.totalWages, 0)),
      bonus: eligibleRows.reduce((sum, row) => sum + row.bonus, 0),
    },
  }
}

/** "8.33" rather than "8.330", for headings. */
export function percentageLabel(percentage: number): string {
  return `${Number(percentage.toFixed(3))}%`
}

/**
 * The statement laid out like the bonus workbook it replaces: one row per
 * employee with a present-days and a wages column for every month, then total
 * man days, total wages and the bonus; and a second sheet summarising eligible
 * employees by department.
 */
export async function toStatementExcel(statement: Statement, organizationName: string): Promise<Buffer> {
  const { months, rows, summary, totals, query } = statement
  const bonusHeading = `Bonus @ ${percentageLabel(query.percentage)}`
  const first = months[0]
  const last = months[months.length - 1]
  const title = first && last ? `Bonus ${shortLabel(first.year, first.month)} to ${shortLabel(last.year, last.month)}` : 'Bonus'

  const workbook = new ExcelJS.Workbook()
  workbook.creator = organizationName
  workbook.created = new Date()

  // ---- Master sheet -------------------------------------------------------
  const sheet = workbook.addWorksheet('Master_Bonus')
  const FIXED = 5
  const monthColumns = months.length * 2
  const totalColumns = FIXED + monthColumns + 4

  // Row 1: title over the identity columns, a merged month label over each pair.
  const groupRow = sheet.getRow(1)
  groupRow.getCell(3).value = title
  months.forEach((entry, position) => {
    const start = FIXED + 1 + position * 2
    groupRow.getCell(start).value = entry.label
    sheet.mergeCells(1, start, 1, start + 1)
  })
  const totalsStart = FIXED + monthColumns + 1
  groupRow.getCell(totalsStart).value = 'Bonus Calculation'
  sheet.mergeCells(1, totalsStart, 1, totalsStart + 3)

  // Row 2: column headings.
  const headings = ['SL.NO', 'EMP ID', 'EMP.NAME', 'DEPARTMENT', 'SECTION']
  for (let position = 0; position < months.length; position += 1) headings.push('TOTAL PRESENT', 'MONTHLY WAGES')
  headings.push('Total Man Days', 'Total Wages', 'Eligible', bonusHeading)
  const headingRow = sheet.addRow([])
  // addRow appended after the pre-filled row 1, so row 2 is the heading row.
  headings.forEach((text, index) => {
    headingRow.getCell(index + 1).value = text
  })

  for (const rowNumber of [1, 2]) {
    const row = sheet.getRow(rowNumber)
    row.font = { bold: true }
    row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    for (let column = 1; column <= totalColumns; column += 1) {
      const cell = row.getCell(column)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } }
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    }
  }

  rows.forEach((row, index) => {
    const values: (string | number)[] = [index + 1, row.employeeCode, row.employeeName, row.departmentName ?? '', row.sectionName ?? '']
    for (const cell of row.months) values.push(cell.manDays, cell.wages)
    values.push(row.totalManDays, row.totalWages, row.eligible ? 'Yes' : 'No', row.bonus)
    sheet.addRow(values)
  })

  if (rows.length > 0) {
    const totalValues: (string | number)[] = ['Total', '', '', '', '']
    for (let position = 0; position < months.length; position += 1) {
      totalValues.push(
        round2(rows.reduce((sum, row) => sum + (row.months[position]?.manDays ?? 0), 0)),
        round2(rows.reduce((sum, row) => sum + (row.months[position]?.wages ?? 0), 0)),
      )
    }
    totalValues.push(
      round2(rows.reduce((sum, row) => sum + row.totalManDays, 0)),
      round2(rows.reduce((sum, row) => sum + row.totalWages, 0)),
      '',
      rows.reduce((sum, row) => sum + row.bonus, 0),
    )
    const totalRow = sheet.addRow(totalValues)
    totalRow.font = { bold: true }
  }

  sheet.getColumn(1).width = 7
  sheet.getColumn(2).width = 12
  sheet.getColumn(3).width = 28
  sheet.getColumn(4).width = 24
  sheet.getColumn(5).width = 16
  for (let column = FIXED + 1; column <= totalColumns; column += 1) {
    const sheetColumn = sheet.getColumn(column)
    const isDays = column <= FIXED + monthColumns && (column - FIXED) % 2 === 1
    sheetColumn.width = isDays ? 10 : 14
    if (column > FIXED && !isDays && column !== totalColumns - 1) sheetColumn.numFmt = '#,##0.00'
    if (isDays) sheetColumn.numFmt = '0.0'
  }
  sheet.getColumn(totalColumns).numFmt = '#,##0'
  sheet.getColumn(totalColumns - 1).width = 10
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 2 }]

  // ---- Summary sheet ------------------------------------------------------
  const pivot = workbook.addWorksheet('Summary')
  pivot.addRow(['Eligibility', 'Yes'])
  pivot.getRow(1).font = { bold: true }
  pivot.addRow([])
  const head = pivot.addRow(['Row Labels', 'Count of EMP ID', 'Sum of Total Man Days', `Sum of ${bonusHeading}`])
  head.font = { bold: true }
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } }
  })
  for (const entry of summary) pivot.addRow([entry.departmentName, entry.employees, entry.manDays, entry.bonus])
  const grand = pivot.addRow(['Grand Total', totals.employees, totals.manDays, totals.bonus])
  grand.font = { bold: true }
  pivot.getColumn(1).width = 34
  pivot.getColumn(2).width = 18
  pivot.getColumn(3).width = 24
  pivot.getColumn(4).width = 26
  pivot.getColumn(4).numFmt = '#,##0'

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
