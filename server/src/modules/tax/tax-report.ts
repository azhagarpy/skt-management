import ExcelJS from 'exceljs'
import { z } from 'zod'
import { pool, type Queryable } from '../../database/pool.js'
import { buildStatement, type StatementMonth } from '../bonuses/bonus-statement.js'

/**
 * Tax slabs and the tax report.
 *
 * A slab is a wage limit and the tax amount for a wage up to it; the one slab
 * with no limit takes everything above the last limit. Tax for an employee is
 * the amount of the slab their *total wages over the report period* fall in - a
 * half-year for the usual filing, so a total of 88,061 lands in the top slab
 * even though no single month came near it.
 *
 * Wages are the same figure the bonus statement uses: the salary-structure
 * earnings on each month's payslip, without bonuses, overtime or adjustments.
 */

// ---------------------------------------------------------------------------
// Slabs
// ---------------------------------------------------------------------------

export interface TaxSlab {
  /** Null for the open-ended top slab. */
  upTo: number | null
  taxAmount: number
}

export const MAX_SLABS = 20

export const slabsSchema = z
  .object({
    slabs: z
      .array(
        z.object({
          upTo: z.coerce.number().gt(0, 'A wage limit must be greater than zero').max(999_999_999).nullable(),
          taxAmount: z.coerce.number().min(0, 'Tax cannot be negative').max(99_999_999),
        }),
      )
      .min(1, 'Add at least one slab')
      .max(MAX_SLABS),
  })
  .superRefine(({ slabs }, ctx) => {
    slabs.forEach((slab, index) => {
      const isLast = index === slabs.length - 1
      if (isLast && slab.upTo !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slabs', index, 'upTo'],
          message: 'The last slab must have no upper limit (it covers everything above)',
        })
      }
      if (!isLast && slab.upTo === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slabs', index, 'upTo'],
          message: 'Only the last slab can have no upper limit',
        })
      }
      const previous = slabs[index - 1]
      if (previous?.upTo != null && slab.upTo !== null && slab.upTo <= previous.upTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slabs', index, 'upTo'],
          message: 'Each limit must be higher than the one before it',
        })
      }
    })
  })

export type SlabsInput = z.infer<typeof slabsSchema>

/** The tax for a wage. No slabs at all means no tax. */
export function taxFor(wages: number, slabs: TaxSlab[]): number {
  for (const slab of slabs) {
    if (slab.upTo === null || wages <= slab.upTo) return slab.taxAmount
  }
  return 0
}

const rupees = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2))

/**
 * "21000 Upto", "21001-30000", "75001- Above": each band named by the wages it
 * covers. A band starts one rupee (or paisa) above the limit before it.
 */
export function slabLabels(slabs: TaxSlab[]): string[] {
  return slabs.map((slab, index) => {
    const previous = slabs[index - 1]
    if (!previous || previous.upTo === null) return slab.upTo === null ? 'All wages' : `${rupees(slab.upTo)} Upto`
    const start = Number.isInteger(previous.upTo) ? previous.upTo + 1 : Math.round((previous.upTo + 0.01) * 100) / 100
    return slab.upTo === null ? `${rupees(start)}- Above` : `${rupees(start)}-${rupees(slab.upTo)}`
  })
}

export async function loadSlabs(organizationId: string, db: Queryable = pool): Promise<TaxSlab[]> {
  const { rows } = await db.query<{ up_to: string | null; tax_amount: string }>(
    'SELECT up_to, tax_amount FROM tax_slabs WHERE organization_id = $1 ORDER BY up_to ASC NULLS LAST',
    [organizationId],
  )
  return rows.map((row) => ({ upTo: row.up_to === null ? null : Number(row.up_to), taxAmount: Number(row.tax_amount) }))
}

/** The standard bands, used for a new organization. */
export const DEFAULT_SLABS: TaxSlab[] = [
  { upTo: 21_000, taxAmount: 0 },
  { upTo: 30_000, taxAmount: 120 },
  { upTo: 45_000, taxAmount: 300 },
  { upTo: 60_000, taxAmount: 590 },
  { upTo: 75_000, taxAmount: 890 },
  { upTo: null, taxAmount: 1180 },
]

/** Gives an organization the standard bands if it has none yet. */
export async function seedDefaultSlabs(organizationId: string, db: Queryable = pool): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM tax_slabs WHERE organization_id = $1 LIMIT 1', [organizationId])
  if (rows.length > 0) return
  for (const slab of DEFAULT_SLABS) {
    await db.query('INSERT INTO tax_slabs (organization_id, up_to, tax_amount) VALUES ($1, $2, $3)', [
      organizationId,
      slab.upTo,
      slab.taxAmount,
    ])
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** A year of months is the longest period anyone files tax over. */
export const MAX_REPORT_MONTHS = 12

const monthIndex = (year: number, month: number): number => year * 12 + (month - 1)

const taxPeriodShape = {
  fromYear: z.coerce.number().int().min(1970).max(2200),
  fromMonth: z.coerce.number().int().min(1).max(12),
  toYear: z.coerce.number().int().min(1970).max(2200),
  toMonth: z.coerce.number().int().min(1).max(12),
  departmentId: z.string().uuid().optional(),
}

/** Rejects a backwards period, or one longer than a year. */
function checkPeriod(
  value: { fromYear: number; fromMonth: number; toYear: number; toMonth: number },
  ctx: z.RefinementCtx,
): void {
  const from = monthIndex(value.fromYear, value.fromMonth)
  const to = monthIndex(value.toYear, value.toMonth)
  if (to < from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toMonth'], message: 'The end month is before the start month' })
  } else if (to - from + 1 > MAX_REPORT_MONTHS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toMonth'],
      message: `Choose a period of ${MAX_REPORT_MONTHS} months or fewer`,
    })
  }
}

export const taxReportQuerySchema = z.object(taxPeriodShape).superRefine(checkPeriod)

/**
 * Deduct the tax the report shows from pay: the same period and department, plus
 * the payroll month it comes out of.
 */
export const taxDeductSchema = z
  .object({
    ...taxPeriodShape,
    payrollYear: z.coerce.number().int().min(1970).max(2200),
    payrollMonth: z.coerce.number().int().min(1).max(12),
  })
  .superRefine(checkPeriod)

export type TaxDeductInput = z.infer<typeof taxDeductSchema>

export type TaxReportQuery = z.infer<typeof taxReportQuerySchema>

export interface TaxReportRow {
  employeeId: string
  employeeCode: string
  employeeName: string
  /** Wages for each month in `months`, in the same order. */
  wages: number[]
  totalWages: number
  tax: number
}

export interface TaxReportGroup {
  departmentName: string
  rows: TaxReportRow[]
  totals: { wages: number[]; totalWages: number; tax: number }
}

export interface TaxReport {
  query: TaxReportQuery
  months: StatementMonth[]
  slabs: (TaxSlab & { label: string })[]
  groups: TaxReportGroup[]
  totals: { employees: number; totalWages: number; tax: number }
}

const round2 = (value: number): number => Math.round(value * 100) / 100

export async function buildTaxReport(organizationId: string, query: TaxReportQuery): Promise<TaxReport> {
  const slabs = await loadSlabs(organizationId)

  // The wage matrix is the one the bonus statement is built on; the bonus
  // percentage and minimum days it also takes are irrelevant here.
  const statement = await buildStatement(
    { organizationId },
    { ...query, percentage: 1, minManDays: 0 },
  )
  return assembleTaxReport(statement.months, statement.rows, slabs, query)
}

/** The arithmetic of the report, apart from where the wages come from. */
export function assembleTaxReport(
  months: StatementMonth[],
  rows: { employeeId: string; employeeCode: string; employeeName: string; departmentName: string | null; months: { wages: number }[]; totalWages: number }[],
  slabs: TaxSlab[],
  query: TaxReportQuery,
): TaxReport {
  const byDepartment = new Map<string, TaxReportRow[]>()
  for (const row of rows) {
    const name = row.departmentName ?? 'No department'
    const list = byDepartment.get(name) ?? []
    list.push({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      wages: row.months.map((cell) => cell.wages),
      totalWages: row.totalWages,
      tax: taxFor(row.totalWages, slabs),
    })
    byDepartment.set(name, list)
  }

  const groups: TaxReportGroup[] = [...byDepartment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([departmentName, list]) => ({
      departmentName,
      rows: list,
      totals: {
        wages: months.map((_, position) => round2(list.reduce((sum, row) => sum + (row.wages[position] ?? 0), 0))),
        totalWages: round2(list.reduce((sum, row) => sum + row.totalWages, 0)),
        tax: list.reduce((sum, row) => sum + row.tax, 0),
      },
    }))

  const labels = slabLabels(slabs)
  return {
    query,
    months,
    slabs: slabs.map((slab, index) => ({ ...slab, label: labels[index] ?? '' })),
    groups,
    totals: {
      employees: groups.reduce((sum, group) => sum + group.rows.length, 0),
      totalWages: round2(groups.reduce((sum, group) => sum + group.totals.totalWages, 0)),
      tax: groups.reduce((sum, group) => sum + group.totals.tax, 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const titleMonth = (year: number, month: number): string => `${SHORT_MONTHS[month - 1]}-${String(year).slice(-2)}`

/** A worksheet name: at most 31 characters, none of \ / ? * [ ] :, and unique in the workbook. */
function sheetName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet'
  let name = base
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
    const tail = ` (${suffix})`
    name = `${base.slice(0, 31 - tail.length)}${tail}`
  }
  taken.add(name.toLowerCase())
  return name
}

/**
 * The report laid out like the P.TAX workbook: one sheet per department, each
 * with the organization and period as a title, a row per employee with a wages
 * column for every month, Total Wages and P.Tax, a Total row, and the slab table
 * alongside.
 */
export async function toTaxExcel(report: TaxReport, organizationName: string): Promise<Buffer> {
  const { months, groups, slabs, query } = report
  const first = months[0]
  const last = months[months.length - 1]
  const period = first && last ? `${titleMonth(first.year, first.month)} to ${titleMonth(last.year, last.month)}` : ''
  const title = `${period} Workmen wages details for ( Panchayat tax )`

  const workbook = new ExcelJS.Workbook()
  workbook.creator = organizationName
  workbook.created = new Date()

  const taken = new Set<string>()
  const departments =
    groups.length > 0
      ? groups
      : [{ departmentName: 'Panchayat Tax', rows: [], totals: { wages: [], totalWages: 0, tax: 0 } } as TaxReportGroup]

  for (const group of departments) {
    const sheet = workbook.addWorksheet(sheetName(group.departmentName, taken))
    const totalWagesColumn = 4 + months.length
    const taxColumn = totalWagesColumn + 1

    sheet.mergeCells(1, 1, 1, taxColumn)
    sheet.getCell(1, 1).value = organizationName
    sheet.mergeCells(2, 1, 2, taxColumn)
    sheet.getCell(2, 1).value = title
    for (const rowNumber of [1, 2]) {
      const row = sheet.getRow(rowNumber)
      row.font = { bold: true, size: rowNumber === 1 ? 14 : 11 }
      row.alignment = { horizontal: 'center' }
    }

    const heading = sheet.getRow(3)
    heading.getCell(1).value = 'Sr.No'
    heading.getCell(2).value = 'Emp ID'
    heading.getCell(3).value = 'Emp Name'
    months.forEach((entry, position) => {
      const cell = heading.getCell(4 + position)
      cell.value = new Date(Date.UTC(entry.year, entry.month - 1, 1))
      cell.numFmt = 'mmm-yy'
    })
    heading.getCell(totalWagesColumn).value = 'Total Wages'
    heading.getCell(taxColumn).value = 'P.Tax'
    heading.font = { bold: true }
    for (let column = 1; column <= taxColumn; column += 1) {
      const cell = heading.getCell(column)
      cell.alignment = { horizontal: column <= 3 ? 'left' : 'right' }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } }
    }

    group.rows.forEach((row, index) => {
      sheet.addRow([index + 1, row.employeeCode, row.employeeName, ...row.wages, row.totalWages, row.tax])
    })

    if (group.rows.length > 0) {
      const totalRow = sheet.addRow(['Total', '', '', ...group.totals.wages, group.totals.totalWages, group.totals.tax])
      totalRow.font = { bold: true }
      sheet.mergeCells(totalRow.number, 1, totalRow.number, 3)
    }

    sheet.getColumn(1).width = 8
    sheet.getColumn(2).width = 12
    sheet.getColumn(3).width = 28
    for (let column = 4; column <= totalWagesColumn; column += 1) {
      sheet.getColumn(column).width = 13
      sheet.getColumn(column).numFmt = '#,##0.00'
    }
    sheet.getColumn(taxColumn).width = 11
    sheet.getColumn(taxColumn).numFmt = '#,##0'
    heading.eachCell((cell, column) => {
      if (column >= 4 && column < totalWagesColumn) cell.numFmt = 'mmm-yy'
    })

    // The slab table sits to the right, as in the original workbook.
    const legendColumn = taxColumn + 2
    slabs.forEach((slab, index) => {
      const row = sheet.getRow(3 + index)
      row.getCell(legendColumn).value = slab.label
      row.getCell(legendColumn + 1).value = slab.taxAmount === 0 ? '-' : slab.taxAmount
      row.getCell(legendColumn + 1).alignment = { horizontal: 'right' }
    })
    sheet.getColumn(legendColumn).width = 16
    sheet.getColumn(legendColumn + 1).width = 10

    sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 3 }]
  }

  // Keep the query in the workbook properties so a file can be traced to the request.
  workbook.description = `Tax report ${query.fromYear}-${query.fromMonth} to ${query.toYear}-${query.toMonth}`

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
