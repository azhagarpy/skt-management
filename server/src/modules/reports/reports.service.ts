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
  type ReportDefinition,
} from './report-definitions.js'

/**
 * The generic report runner.
 *
 * A report definition supplies a SQL body with `{{scope}}` and `{{filters}}`
 * placeholders; this module substitutes the caller's employee scope and the
 * bound filter predicates, then returns rows, totals and metadata that the
 * exporters render into CSV, Excel or PDF.
 */

export const reportFilterSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  departmentId: z.string().uuid().optional(),
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
  departmentId: (index) => `e.department_id = $${index}`,
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
  'monthly-attendance-summary': { from: 'a.attendance_date', to: 'a.attendance_date' },
  'leave-requests': { from: 'r.to_date', to: 'r.from_date' },
  'leave-balances': { year: 'b.leave_year' },
  'salary-register': { year: 'r.year', month: 'r.month' },
  'payment-status': { year: 'r.year', month: 'r.month' },
  'payment-transactions': { from: 't.payment_date', to: 't.payment_date' },
  'bonus-report': { year: 'b.payroll_year', month: 'b.payroll_month' },
  'tax-deductions-report': { year: 't.payroll_year', month: 't.payroll_month' },
  'other-deductions-report': { year: 'a.apply_year', month: 'a.apply_month' },
  'lwf-report': { year: 'l.contribution_year' },
  'pl-wages-report': { year: 'c.credit_year' },
  'pf-report': { year: 'r.year', month: 'r.month' },
  'esi-report': { year: 'r.year', month: 'r.month' },
  'department-salary': { year: 'r.year', month: 'r.month' },
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
    if (filterKey === 'from' || filterKey === 'to' || filterKey === 'year' || filterKey === 'month') {
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
  const pagingParams = includePaging ? [filters.pageSize, (filters.page - 1) * filters.pageSize] : []

  return {
    sql: `${body} ORDER BY ${definition.orderBy}${paging}`,
    countSql: `SELECT count(*)::text AS count FROM (${body}) report_rows`,
    params: includePaging ? [...params, ...pagingParams] : params,
  }
}

function assertRequiredFilters(definition: ReportDefinition, filters: ReportFilters): void {
  for (const required of definition.requiredFilters ?? []) {
    const value = filters[required as keyof ReportFilters]
    if (value === undefined || value === null || value === '') {
      throw ApiError.badRequest(`The ${definition.name} report requires the "${required}" filter`)
    }
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

  return REPORT_DEFINITIONS.map((definition) => ({
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
  totals: Record<string, number>
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

export async function runReport(auth: AuthContext, key: string, filters: ReportFilters): Promise<ReportResult> {
  const definition = findReportDefinition(key)
  if (!definition) throw ApiError.notFound('Report')

  const scope = reportScope(auth)
  if (!auth.has(definition.permission) && !auth.has(PERMISSIONS.REPORT_VIEW_TEAM)) {
    throw ApiError.forbidden('You do not have permission to run this report')
  }
  assertRequiredFilters(definition, filters)

  const paged = buildQuery(definition, auth, scope, filters, true)
  const counted = buildQuery(definition, auth, scope, filters, false)

  const countRow = await queryOne<{ count: string }>(pool, counted.countSql, counted.params)
  const rows = await queryRows<Record<string, unknown>>(pool, paged.sql, paged.params)

  const paginated = buildPaginated(rows, Number(countRow?.count ?? 0), filters.page, filters.pageSize)

  return {
    key: definition.key,
    name: definition.name,
    columns: definition.columns,
    rows: paginated.items,
    totals: computeTotals(definition, rows),
    page: paginated.page,
    pageSize: paginated.pageSize,
    total: paginated.total,
    totalPages: paginated.totalPages,
    filters,
  }
}

/** Runs a report unpaged, for export. Capped so an export cannot exhaust memory. */
export async function runReportForExport(
  auth: AuthContext,
  key: string,
  filters: ReportFilters,
): Promise<{ definition: ReportDefinition; rows: Record<string, unknown>[]; totals: Record<string, number> }> {
  const definition = findReportDefinition(key)
  if (!definition) throw ApiError.notFound('Report')

  const scope = reportScope(auth)
  assertRequiredFilters(definition, filters)

  const MAX_EXPORT_ROWS = 50_000
  const built = buildQuery(definition, auth, scope, { ...filters, page: 1, pageSize: MAX_EXPORT_ROWS }, true)
  const rows = await queryRows<Record<string, unknown>>(pool, built.sql, built.params)

  if (rows.length >= MAX_EXPORT_ROWS) {
    throw ApiError.businessRule(
      `This export exceeds ${MAX_EXPORT_ROWS.toLocaleString()} rows. Narrow the filters and try again.`,
    )
  }

  return { definition, rows, totals: computeTotals(definition, rows) }
}
