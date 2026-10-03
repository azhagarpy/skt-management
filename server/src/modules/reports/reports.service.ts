import { z } from 'zod'
import { ApiError } from '../../utils/api-error.js'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { buildPaginated } from '../../utils/pagination.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { resolveScope, scopeClause, type EmployeeScope } from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'
import {
  findReportDefinition,
  REPORT_DEFINITIONS,
  type FilterKey,
  type ReportColumn,
  type ReportDefinition,
} from './report-definitions.js'
import { idListParam } from '../../utils/query-params.js'
import { payCycleFor, PAYROLL_CYCLE_CUTOFF_DAY } from '../../utils/dates.js'
import { addHolidayAmounts, addOvertimeAmounts, addRegisterHolidayFigures, type ReportRow } from './report-amounts.js'
import { addAttendanceDays, addAttendanceTotals } from './report-attendance.js'

/**
 * The generic report runner.
 *
 * A report definition supplies a SQL body with `{{scope}}` and `{{filters}}`
 * placeholders; this module substitutes the caller's employee scope and the
 * bound filter predicates, then returns rows, totals and metadata that the
 * exporters render into CSV, Excel or PDF.
 */

/** A payroll month, "YYYY-MM". */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** The longest month range a report runs over: two years. */
const MAX_RANGE_MONTHS = 24

/** "2026-03" -> { year: 2026, month: 3 } */
function parseMonth(value: string): { year: number; month: number } {
  const [year, month] = value.split('-')
  return { year: Number(year), month: Number(month) }
}

/** A month as one comparable number: "2026-03" -> 202603. */
const monthNumber = (value: string): number => parseMonth(value).year * 100 + parseMonth(value).month

export const reportFilterSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  fromMonth: z.string().regex(MONTH_PATTERN, 'Choose a month as YYYY-MM').optional(),
  toMonth: z.string().regex(MONTH_PATTERN, 'Choose a month as YYYY-MM').optional(),
  departmentId: idListParam.optional(),
  supervisorId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  employmentStatus: z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'RESIGNED', 'TERMINATED']).optional(),
  attendanceStatus: z
    .enum(['PRESENT', 'ABSENT', 'ON_LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF'])
    .optional(),
  leaveStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  paymentStatus: z.enum(['PENDING', 'PARTIALLY_PAID', 'PAID']).optional(),
  payrollRunId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
})

export type ReportFilters = z.infer<typeof reportFilterSchema>

export const exportQuerySchema = reportFilterSchema.extend({
  // `ecr` is the PF portal's upload text and exists for the PF report only.
  format: z.enum(['csv', 'xlsx', 'pdf', 'ecr']).default('csv'),
  /** The columns to export, by key, comma separated; every column when left out. */
  columns: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(','))
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, 'Unknown column')).max(200))
    .optional(),
})

export type ExportQuery = z.infer<typeof exportQuerySchema>

/**
 * How each filter key turns into a SQL predicate.
 *
 * Keeping this in one table means a report author picks filter names, never
 * writes SQL for them, so a filter cannot accidentally reach the wrong column.
 */
// Period filters (from/to/year/month) are not listed here: they resolve against
// each report's own date columns via DATE_COLUMN_BY_REPORT below.
const FILTER_SQL: Partial<Record<FilterKey, (paramIndex: number) => string>> = {
  departmentId: (index) => `e.department_id = ANY($${index}::uuid[])`,
  supervisorId: (index) => `e.supervisor_id = $${index}`,
  employeeId: (index) => `e.id = $${index}`,
  locationId: (index) => `e.location_id = $${index}`,
  employmentStatus: (index) => `e.employment_status = $${index}`,
  attendanceStatus: (index) => `a.status = $${index}`,
  leaveStatus: (index) => `r.status = $${index}`,
  paymentStatus: (index) => `i.payment_status = $${index}`,
  payrollRunId: (index) => `i.payroll_run_id = $${index}`,
}

/**
 * Date and period filters depend on which table the report is built on, so each
 * report declares them through its own column mapping rather than a global one.
 */
const DATE_COLUMN_BY_REPORT: Record<string, { from?: string; to?: string; year?: string; month?: string }> = {
  'daily-attendance': { from: 'a.attendance_date', to: 'a.attendance_date' },
  'holiday-report': {
    from: 'h.holiday_date',
    to: 'h.holiday_date',
    year: 'EXTRACT(YEAR FROM h.holiday_date)::int',
    month: 'EXTRACT(MONTH FROM h.holiday_date)::int',
  },
  // Its month is turned into dates by resolvePayrollMonth.
  'overtime-report': { from: 'o.work_date', to: 'o.work_date' },
  // Everyone employed at some point in the period: they left on or after its
  // first day and joined by its last. Its month is turned into dates by
  // resolvePayrollMonth.
  'monthly-attendance-summary': { from: "coalesce(e.exit_date, 'infinity'::date)", to: 'e.joining_date' },
  'leave-requests': { from: 'r.to_date', to: 'r.from_date' },
  'leave-balances': { year: 'b.leave_year' },
  'salary-register': { year: 'r.year', month: 'r.month' },
  'payment-status': { year: 'r.year', month: 'r.month' },
  'payment-transactions': { from: 't.payment_date', to: 't.payment_date' },
  'bank-transfer': { year: 'r.year', month: 'r.month' },
  'bonus-report': { year: 'b.payroll_year', month: 'b.payroll_month' },
  'tax-deductions-report': { year: 't.payroll_year', month: 't.payroll_month' },
  'other-deductions-report': { year: 'a.apply_year', month: 'a.apply_month' },
  'other-credits-report': { year: 'a.apply_year', month: 'a.apply_month' },
  'lwf-report': { year: 'l.contribution_year' },
  'pl-wages-report': { year: 'c.credit_year' },
  'pf-report': { year: 'r.year', month: 'r.month' },
  'esi-report': { year: 'r.year', month: 'r.month' },
  'department-salary': { year: 'r.year', month: 'r.month' },
  'payroll-summary': { year: 'r.year', month: 'r.month' },
  'payroll-month-summary': { year: 'r.year', month: 'r.month' },
  // As the Monthly Attendance report: everyone employed at some point in the period.
  'attendance-summary': { from: "coalesce(e.exit_date, 'infinity'::date)", to: 'e.joining_date' },
}

/**
 * Reports whose month is the payroll month rather than the calendar month, so
 * they agree with what that month's payroll paid.
 */
const PAYROLL_MONTH_REPORTS = new Set(['overtime-report', 'monthly-attendance-summary', 'attendance-summary'])

/**
 * Columns SQL cannot work out - amounts that follow payroll's own rules, or
 * each day's attendance - are filled in afterwards by these, given the
 * report's rows and its resolved filters. A report with one is paged and
 * totalled in memory, over every matching row, rather than in SQL.
 */
const ENRICH_BY_REPORT: Record<
  string,
  (organizationId: string, rows: ReportRow[], filters: ReportFilters) => Promise<ReportRow[]>
> = {
  'holiday-report': addHolidayAmounts,
  'overtime-report': addOvertimeAmounts,
  'salary-register': addRegisterHolidayFigures,
  'monthly-attendance-summary': addAttendanceDays,
  'attendance-summary': addAttendanceTotals,
}

/**
 * The dates a payroll month covers: the run's own dates when the month has a
 * run (they can be changed), else the standard cycle, the 21st of the
 * previous month to the 20th.
 */
async function payrollMonthPeriod(organizationId: string, year: number, month: number): Promise<{ start: string; end: string }> {
  const run = await queryOne<{ period_start: string; period_end: string }>(
    pool,
    'SELECT period_start, period_end FROM payroll_runs WHERE organization_id = $1 AND year = $2 AND month = $3',
    [organizationId, year, month],
  )
  return run ? { start: run.period_start, end: run.period_end } : payCycleFor(year, month, PAYROLL_CYCLE_CUTOFF_DAY)
}

/**
 * Turns a payroll-month report's month, or range of months, into the dates it
 * covers: from the first month's first day to the last month's last.
 */
async function resolvePayrollMonth(
  definition: ReportDefinition,
  auth: AuthContext,
  filters: ReportFilters,
): Promise<ReportFilters> {
  if (!PAYROLL_MONTH_REPORTS.has(definition.key)) return filters
  if (filters.fromMonth && filters.toMonth && definition.filters.includes('fromMonth')) {
    const first = parseMonth(filters.fromMonth)
    const last = parseMonth(filters.toMonth)
    const start = (await payrollMonthPeriod(auth.organizationId, first.year, first.month)).start
    const end = (await payrollMonthPeriod(auth.organizationId, last.year, last.month)).end
    return { ...filters, fromMonth: undefined, toMonth: undefined, from: start, to: end }
  }
  if (!filters.year || !filters.month) return filters
  const period = await payrollMonthPeriod(auth.organizationId, filters.year, filters.month)
  return { ...filters, year: undefined, month: undefined, from: period.start, to: period.end }
}

/** A month range must run forwards, and over no more than MAX_RANGE_MONTHS. */
function assertMonthRange(filters: ReportFilters): void {
  if (!filters.fromMonth || !filters.toMonth) return
  const first = parseMonth(filters.fromMonth)
  const last = parseMonth(filters.toMonth)
  const months = (last.year - first.year) * 12 + (last.month - first.month) + 1
  if (months < 1) throw ApiError.badRequest('The last month cannot be before the first')
  if (months > MAX_RANGE_MONTHS) {
    throw ApiError.badRequest(`A report covers up to ${MAX_RANGE_MONTHS} months. Choose a shorter range.`)
  }
}

/** Which payroll month a row belongs to, for a report run over a range of months. */
const MONTH_COLUMN: ReportColumn = { key: 'report_month', label: 'Month', format: 'text' }

/**
 * The definition as it runs for these filters: a report's period-dependent
 * columns are filled in, and one with a row per month run over a month range
 * says which month each row is.
 */
function resolveDefinition(definition: ReportDefinition, filters: ReportFilters): ReportDefinition {
  let columns = definition.columnsFor ? definition.columnsFor({ from: filters.from, to: filters.to }) : definition.columns
  if (definition.monthColumn && filters.fromMonth && filters.toMonth) columns = [MONTH_COLUMN, ...columns]
  return columns === definition.columns ? definition : { ...definition, columns }
}

/** A report carrying sensitive data needs its extra permission as well. */
function assertCanRun(auth: AuthContext, definition: ReportDefinition): void {
  if (definition.requires && !auth.has(definition.requires)) {
    throw ApiError.forbidden(`You do not have permission to run the ${definition.name} report`)
  }
}

interface BuiltQuery {
  sql: string
  countSql: string
  params: unknown[]
}

function buildQuery(
  definition: ReportDefinition,
  auth: AuthContext,
  scope: EmployeeScope,
  filters: ReportFilters,
  includePaging: boolean,
): BuiltQuery {
  const scopePredicate = scopeClause(auth, scope, definition.employeeAlias, 1)
  const params: unknown[] = [...scopePredicate.params]
  const predicates: string[] = []

  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const dateColumns = DATE_COLUMN_BY_REPORT[definition.key] ?? {}

  for (const filterKey of definition.filters) {
    const value = filters[filterKey as keyof ReportFilters]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue

    // Period filters resolve against the report's own date columns.
    if (filterKey === 'from' && dateColumns.from) {
      predicates.push(`${dateColumns.from} >= $${push(value)}`)
      continue
    }
    if (filterKey === 'to' && dateColumns.to) {
      predicates.push(`${dateColumns.to} <= $${push(value)}`)
      continue
    }
    if (filterKey === 'year' && dateColumns.year) {
      predicates.push(`${dateColumns.year} = $${push(value)}`)
      continue
    }
    if (filterKey === 'month' && dateColumns.month) {
      predicates.push(`${dateColumns.month} = $${push(value)}`)
      continue
    }
    // A month range compares year and month as one number, 202603 for March 2026.
    if ((filterKey === 'fromMonth' || filterKey === 'toMonth') && dateColumns.year && dateColumns.month) {
      const operator = filterKey === 'fromMonth' ? '>=' : '<='
      predicates.push(`(${dateColumns.year} * 100 + ${dateColumns.month}) ${operator} $${push(monthNumber(String(value)))}`)
      continue
    }
    if (
      filterKey === 'from' ||
      filterKey === 'to' ||
      filterKey === 'year' ||
      filterKey === 'month' ||
      filterKey === 'fromMonth' ||
      filterKey === 'toMonth'
    ) {
      // The report does not map this period filter; ignore rather than guess.
      continue
    }

    const builder = FILTER_SQL[filterKey]
    if (!builder) continue
    predicates.push(builder(push(value)))
  }

  const filterSql = predicates.length > 0 ? `AND ${predicates.join(' AND ')}` : ''
  const body = definition.sql.replace('{{scope}}', `(${scopePredicate.sql})`).replace('{{filters}}', filterSql)

  const paging = includePaging
    ? ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    : ''

  // The row count and every totalled column, summed over all matching rows
  // rather than one page, so the screen can show the whole report's totals.
  // Column keys come from the definition, never the request.
  const totalSelects = definition.columns
    .filter((column) => column.total)
    .map((column) => `, coalesce(sum((report_rows."${column.key}")::numeric), 0)::text AS "${column.key}"`)
    .join('')
  const pagingParams = includePaging ? [filters.pageSize, (filters.page - 1) * filters.pageSize] : []

  return {
    sql: `${body} ORDER BY ${definition.orderBy}${paging}`,
    countSql: `SELECT count(*)::text AS count${totalSelects} FROM (${body}) report_rows`,
    params: includePaging ? [...params, ...pagingParams] : params,
  }
}

function assertRequiredFilters(definition: ReportDefinition, filters: ReportFilters): void {
  const isGiven = (key: FilterKey): boolean => {
    const value = filters[key as keyof ReportFilters]
    return value !== undefined && value !== null && value !== ''
  }

  for (const required of definition.requiredFilters ?? []) {
    if (!isGiven(required)) {
      throw ApiError.badRequest(`The ${definition.name} report requires the "${required}" filter`)
    }
  }

  const alternatives = definition.requiredOneOf ?? []
  if (alternatives.length > 0 && !alternatives.some((set) => set.every(isGiven))) {
    const options = alternatives.map((set) => set.map((key) => `"${key}"`).join(' and ')).join(', or ')
    throw ApiError.badRequest(`${definition.name} needs the ${options} filters`)
  }
}

/**
 * A supervisor may only run reports over their own team, so the scope is
 * resolved from permissions rather than trusted from the request.
 */
function reportScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.REPORT_VIEW_ALL,
    team: PERMISSIONS.REPORT_VIEW_TEAM,
  })
}

export function listReports(auth: AuthContext) {
  const scope = auth.has(PERMISSIONS.REPORT_VIEW_ALL) ? 'ALL' : auth.has(PERMISSIONS.REPORT_VIEW_TEAM) ? 'TEAM' : null
  if (!scope) throw ApiError.forbidden('You do not have permission to view reports')

  return REPORT_DEFINITIONS.filter((definition) => !definition.requires || auth.has(definition.requires)).map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    columns: definition.columns,
    filters: definition.filters,
    requiredFilters: definition.requiredFilters ?? [],
  }))
}

export interface ReportResult {
  key: string
  name: string
  columns: ReportDefinition['columns']
  rows: Record<string, unknown>[]
  /** Totals of the rows on this page. */
  totals: Record<string, number>
  /** Totals of every row the filters match, across all pages. */
  grandTotals: Record<string, number>
  page: number
  pageSize: number
  total: number
  totalPages: number
  filters: ReportFilters
}

function computeTotals(definition: ReportDefinition, rows: Record<string, unknown>[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const column of definition.columns) {
    if (!column.total) continue
    const sum = rows.reduce((running, row) => {
      const value = Number(row[column.key] ?? 0)
      return running + (Number.isFinite(value) ? value : 0)
    }, 0)
    totals[column.key] = Number(sum.toFixed(2))
  }
  return totals
}

function grandTotalsFrom(definition: ReportDefinition, row: Record<string, string> | null): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const column of definition.columns) {
    if (!column.total) continue
    totals[column.key] = Number(Number(row?.[column.key] ?? 0).toFixed(2))
  }
  return totals
}

export async function runReport(auth: AuthContext, key: string, filters: ReportFilters): Promise<ReportResult> {
  const found = findReportDefinition(key)
  if (!found) throw ApiError.notFound('Report')

  const scope = reportScope(auth)
  if (!auth.has(found.permission) && !auth.has(PERMISSIONS.REPORT_VIEW_TEAM)) {
    throw ApiError.forbidden('You do not have permission to run this report')
  }
  assertCanRun(auth, found)
  assertRequiredFilters(found, filters)
  assertMonthRange(filters)
  const queryFilters = await resolvePayrollMonth(found, auth, filters)
  const definition = resolveDefinition(found, queryFilters)

  let rows: ReportRow[]
  let total: number
  let grandTotals: Record<string, number>

  const enrich = ENRICH_BY_REPORT[definition.key]
  if (enrich) {
    const all = await enrich(auth.organizationId, await loadAllRows(definition, auth, scope, queryFilters), queryFilters)
    const offset = (filters.page - 1) * filters.pageSize
    rows = all.slice(offset, offset + filters.pageSize)
    total = all.length
    grandTotals = computeTotals(definition, all)
  } else {
    const paged = buildQuery(definition, auth, scope, queryFilters, true)
    const counted = buildQuery(definition, auth, scope, queryFilters, false)
    const countRow = await queryOne<Record<string, string>>(pool, counted.countSql, counted.params)
    rows = await queryRows<ReportRow>(pool, paged.sql, paged.params)
    total = Number(countRow?.count ?? 0)
    grandTotals = grandTotalsFrom(definition, countRow)
  }

  const paginated = buildPaginated(rows, total, filters.page, filters.pageSize)

  return {
    key: definition.key,
    name: definition.name,
    columns: definition.columns,
    rows: paginated.items,
    totals: computeTotals(definition, rows),
    grandTotals,
    page: paginated.page,
    pageSize: paginated.pageSize,
    total: paginated.total,
    totalPages: paginated.totalPages,
    filters,
  }
}

const MAX_REPORT_ROWS = 50_000

/** Every row the filters match, unpaged. Capped so a report cannot exhaust memory. */
async function loadAllRows(
  definition: ReportDefinition,
  auth: AuthContext,
  scope: EmployeeScope,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const built = buildQuery(definition, auth, scope, { ...filters, page: 1, pageSize: MAX_REPORT_ROWS }, true)
  const rows = await queryRows<ReportRow>(pool, built.sql, built.params)

  if (rows.length >= MAX_REPORT_ROWS) {
    throw ApiError.businessRule(
      `This report has more than ${MAX_REPORT_ROWS.toLocaleString()} rows. Narrow the filters and try again.`,
    )
  }
  return rows
}

/**
 * The columns an export shows: the ones asked for, in the report's own order,
 * or every column when none were asked for (or none of them exist).
 */
export function chooseColumns(definition: ReportDefinition, keys: string[] | undefined): ReportDefinition {
  if (!keys?.length) return definition
  const wanted = new Set(keys)
  const chosen = definition.columns.filter((column) => wanted.has(column.key))
  return chosen.length > 0 ? { ...definition, columns: chosen } : definition
}

/** Runs a report unpaged, for export, with just the columns asked for. */
export async function runReportForExport(
  auth: AuthContext,
  key: string,
  filters: ExportQuery,
): Promise<{ definition: ReportDefinition; rows: Record<string, unknown>[]; totals: Record<string, number> }> {
  const found = findReportDefinition(key)
  if (!found) throw ApiError.notFound('Report')

  const scope = reportScope(auth)
  assertCanRun(auth, found)
  assertRequiredFilters(found, filters)
  assertMonthRange(filters)

  const queryFilters = await resolvePayrollMonth(found, auth, filters)
  const resolved = resolveDefinition(found, queryFilters)
  const loaded = await loadAllRows(resolved, auth, scope, queryFilters)
  const enrich = ENRICH_BY_REPORT[resolved.key]
  const rows = enrich ? await enrich(auth.organizationId, loaded, queryFilters) : loaded

  const definition = chooseColumns(resolved, filters.columns)
  return { definition, rows, totals: computeTotals(definition, rows) }
}
