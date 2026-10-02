import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { firstDayOfMonth, lastDayOfMonth, monthLabel, type IsoDate } from '../../utils/dates.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import {
  buildTaxReport,
  loadSlabs,
  slabLabels,
  slabsSchema,
  taxDeductSchema,
  taxReportQuerySchema,
  toTaxExcel,
  type SlabsInput,
  type TaxDeductInput,
  type TaxReportQuery,
} from './tax-report.js'
import { buildExitTaxPreview, withdrawExitTax } from './tax-on-exit.js'
import {
  assertCanManageEmployee,
  assertEmployeeInScope,
  manageableTeamIds,
  resolveScope,
  scopeClause,
  type EmployeeScope,
} from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'

/**
 * Tax: the tax amount for each band of wages, and the report that applies the
 * bands to what each employee earned over a period (see tax-report.ts).
 *
 * The administrator then chooses the payroll month the tax comes out of pay.
 * That choice is stored per employee (tax_deductions) with the wages it was
 * worked out on, and payroll deducts it as a "P.Tax" line when it calculates that
 * month. A leaver's tax can instead come out of their final salary (see
 * tax-on-exit.ts).
 */

export interface TaxDeductionRow {
  id: string
  employee_id: string
  payroll_year: number
  payroll_month: number
  period_from: IsoDate
  period_to: IsoDate
  wage_base: string
  tax_amount: string
  /** Tax on exit, which payroll works out when it calculates the month. */
  on_exit: boolean
  employee_code?: string
  employee_name?: string
  department_name?: string | null
}

/** What payroll deducts for these employees in this month. */
export async function listTaxDeductionsForPeriod(
  employeeIds: string[],
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<TaxDeductionRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<TaxDeductionRow>(
    db,
    `SELECT * FROM tax_deductions
      WHERE employee_id = ANY($1::uuid[]) AND payroll_year = $2 AND payroll_month = $3`,
    [employeeIds, year, month],
  )
}

/** A month that payroll has approved or locked can no longer take a new deduction. */
async function assertPayrollOpen(organizationId: string, year: number, month: number): Promise<void> {
  const run = await queryOne<{ status: string }>(
    pool,
    `SELECT status::text AS status FROM payroll_runs
      WHERE organization_id = $1 AND year = $2 AND month = $3 AND status IN ('APPROVED', 'LOCKED')`,
    [organizationId, year, month],
  )
  if (run) {
    throw ApiError.businessRule(
      `Payroll for ${month}/${year} is already ${run.status.toLowerCase()}, so tax can no longer be deducted in it. Choose a later month.`,
    )
  }
}

const idParam = z.object({ id: z.string().uuid() })
const employeeIdParam = z.object({ employeeId: z.string().uuid() })
const deductionListSchema = z.object({
  payrollYear: z.coerce.number().int().min(1970).max(2200),
  payrollMonth: z.coerce.number().int().min(1).max(12).optional(),
})

function presentDeduction(row: TaxDeductionRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? null,
    employeeName: row.employee_name ?? null,
    departmentName: row.department_name ?? null,
    payrollYear: row.payroll_year,
    payrollMonth: row.payroll_month,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    wageBase: Number(row.wage_base),
    taxAmount: Number(row.tax_amount),
    onExit: row.on_exit,
  }
}

async function presentSlabs(organizationId: string) {
  const slabs = await loadSlabs(organizationId)
  const labels = slabLabels(slabs)
  return slabs.map((slab, index) => ({ ...slab, label: labels[index] ?? '' }))
}

export const taxRouter = Router()
taxRouter.use(authenticate)

// The slabs are the company's; a supervisor reads them and works out, sets and
// removes the tax of their own team, never their own.
const canView = requireAnyPermission(PERMISSIONS.TAX_VIEW, PERMISSIONS.TAX_VIEW_TEAM)
const canManage = requireAnyPermission(PERMISSIONS.TAX_MANAGE, PERMISSIONS.TAX_MANAGE_TEAM)
const viewScope = (auth: AuthContext): EmployeeScope =>
  resolveScope(auth, { all: PERMISSIONS.TAX_VIEW, team: PERMISSIONS.TAX_VIEW_TEAM })
const manageScope = (auth: AuthContext): EmployeeScope =>
  resolveScope(auth, { all: PERMISSIONS.TAX_MANAGE, team: PERMISSIONS.TAX_MANAGE_TEAM })

/** The employees a report covers: everyone, or those on the caller's team they may change. */
async function reportEmployees(auth: AuthContext, scope: EmployeeScope): Promise<string[] | undefined> {
  return scope === 'ALL' ? undefined : manageableTeamIds(auth)
}

taxRouter.get(
  '/slabs',
  canView,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await presentSlabs(auth.organizationId))
  }),
)

/** Replaces the whole set of slabs at once, so the bands can never be left half-edited. */
taxRouter.put(
  '/slabs',
  requirePermissions(PERMISSIONS.TAX_MANAGE),
  validate({ body: slabsSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as SlabsInput
    const before = await loadSlabs(auth.organizationId)

    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM tax_slabs WHERE organization_id = $1', [auth.organizationId])
      for (const slab of input.slabs) {
        await tx.query('INSERT INTO tax_slabs (organization_id, up_to, tax_amount) VALUES ($1, $2, $3)', [
          auth.organizationId,
          slab.upTo,
          slab.taxAmount,
        ])
      }
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'TAX_SLABS_UPDATED',
      entityType: 'tax_slabs',
      entityId: null,
      oldValues: { slabs: before },
      newValues: { slabs: input.slabs },
    })

    return sendSuccess(res, await presentSlabs(auth.organizationId), 'Tax slabs saved')
  }),
)

taxRouter.get(
  '/report',
  canView,
  validate({ query: taxReportQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const employees = await reportEmployees(auth, viewScope(auth))
    return sendSuccess(res, await buildTaxReport(auth.organizationId, req.query as unknown as TaxReportQuery, employees))
  }),
)

taxRouter.get(
  '/report/export',
  canView,
  requirePermissions(PERMISSIONS.REPORT_EXPORT),
  validate({ query: taxReportQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as TaxReportQuery
    const report = await buildTaxReport(auth.organizationId, query, await reportEmployees(auth, viewScope(auth)))

    const organization = await queryOne<{ name: string }>(pool, 'SELECT name FROM organizations WHERE id = $1', [
      auth.organizationId,
    ])
    const buffer = await toTaxExcel(report, organization?.name ?? 'Organization')

    await recordAudit({
      ...auditContextFrom(req),
      action: 'REPORT_EXPORTED',
      entityType: 'report',
      entityId: null,
      newValues: { report: 'tax', format: 'xlsx', rows: report.totals.employees },
    })

    const pad = (value: number): string => String(value).padStart(2, '0')
    const filename = `ptax-${query.fromYear}-${pad(query.fromMonth)}-to-${query.toYear}-${pad(query.toMonth)}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(buffer)
  }),
)

// ---------------------------------------------------------------------------
// Deducting the tax from salary
// ---------------------------------------------------------------------------

taxRouter.get(
  '/deductions',
  canView,
  validate({ query: deductionListSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as z.infer<typeof deductionListSchema>
    const clause = scopeClause(auth, viewScope(auth), 'e', 3)
    const params: unknown[] = [auth.organizationId, query.payrollYear, ...clause.params]
    let filters = `AND ${clause.sql}`
    if (query.payrollMonth) {
      params.push(query.payrollMonth)
      filters += ` AND t.payroll_month = $${params.length}`
    }
    const rows = await queryRows<TaxDeductionRow>(
      pool,
      `SELECT t.*, e.employee_code,
              trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
              d.name AS department_name
         FROM tax_deductions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE t.organization_id = $1 AND t.payroll_year = $2 ${filters}
        ORDER BY t.payroll_month DESC, e.employee_code`,
      params,
    )
    return sendSuccess(res, rows.map(presentDeduction))
  }),
)

/**
 * Sets the tax the report shows to be deducted in the chosen payroll month.
 *
 * Doing it again for the same month replaces what was set (an employee whose tax
 * has since fallen to nothing has theirs removed), so it can be repeated after a
 * slab or wage correction until payroll for that month is approved.
 *
 * A leaver whose tax for the period already came out of their final salary
 * (tax on exit) is left out, so it is never taken twice.
 */
taxRouter.post(
  '/deductions',
  canManage,
  validate({ body: taxDeductSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as TaxDeductInput
    await assertPayrollOpen(auth.organizationId, input.payrollYear, input.payrollMonth)

    // A supervisor's report holds only their team, so only their rows are set or cleared.
    const report = await buildTaxReport(auth.organizationId, input, await reportEmployees(auth, manageScope(auth)))
    const rows = report.groups.flatMap((group) => group.rows)
    if (rows.length === 0) {
      throw ApiError.businessRule('There is no payroll in that period, so there is no tax to deduct.')
    }
    if (report.slabs.length === 0) {
      throw ApiError.businessRule('Set the tax slabs first - with none, the tax is zero for everyone.')
    }

    const periodFrom = firstDayOfMonth(input.fromYear, input.fromMonth)
    const periodTo = lastDayOfMonth(input.toYear, input.toMonth)
    const takenOnExit = new Set(
      (
        await queryRows<{ employee_id: string }>(
          pool,
          `SELECT DISTINCT employee_id FROM tax_deductions
            WHERE organization_id = $1 AND on_exit
              AND (payroll_year * 12 + payroll_month - 1) BETWEEN $2 AND $3`,
          [
            auth.organizationId,
            input.fromYear * 12 + input.fromMonth - 1,
            input.toYear * 12 + input.toMonth - 1,
          ],
        )
      ).map((row) => row.employee_id),
    )
    const charged = rows.filter((row) => row.tax > 0 && !takenOnExit.has(row.employeeId))
    const cleared = rows.filter((row) => row.tax <= 0 || takenOnExit.has(row.employeeId))
    const onExit = rows.filter((row) => row.tax > 0 && takenOnExit.has(row.employeeId)).length

    await withTransaction(async (tx) => {
      for (const row of charged) {
        await tx.query(
          `INSERT INTO tax_deductions
             (organization_id, employee_id, payroll_year, payroll_month, period_from, period_to,
              wage_base, tax_amount, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (employee_id, payroll_year, payroll_month, on_exit) DO UPDATE
             SET period_from = EXCLUDED.period_from,
                 period_to = EXCLUDED.period_to,
                 wage_base = EXCLUDED.wage_base,
                 tax_amount = EXCLUDED.tax_amount,
                 created_by = EXCLUDED.created_by`,
          [
            auth.organizationId,
            row.employeeId,
            input.payrollYear,
            input.payrollMonth,
            periodFrom,
            periodTo,
            row.totalWages,
            row.tax,
            auth.userId,
          ],
        )
      }
      if (cleared.length > 0) {
        await tx.query(
          `DELETE FROM tax_deductions
            WHERE organization_id = $1 AND payroll_year = $2 AND payroll_month = $3
              AND employee_id = ANY($4::uuid[]) AND NOT on_exit`,
          [auth.organizationId, input.payrollYear, input.payrollMonth, cleared.map((row) => row.employeeId)],
        )
      }
    })

    const total = charged.reduce((sum, row) => sum + row.tax, 0)
    await recordAudit({
      ...auditContextFrom(req),
      action: 'TAX_DEDUCTION_SET',
      entityType: 'tax_deduction',
      entityId: null,
      newValues: {
        period: `${input.fromYear}-${input.fromMonth} to ${input.toYear}-${input.toMonth}`,
        payrollMonth: `${input.payrollYear}-${input.payrollMonth}`,
        departmentId: input.departmentId ?? null,
        employees: charged.length,
        total,
        leftOutTakenOnExit: onExit,
      },
    })

    return sendSuccess(
      res,
      { employees: charged.length, total, noTax: cleared.length - onExit, takenOnExit: onExit },
      `Tax of ${total} will be deducted from ${charged.length} employee${charged.length === 1 ? '' : 's'} in ${input.payrollMonth}/${input.payrollYear}` +
        (onExit > 0 ? ` (${onExit} left out: already deducted from their final salary)` : ''),
    )
  }),
)

/** The tax on exit an employee would have, for the administrator to confirm when marking them as left. */
taxRouter.get(
  '/exit-deductions/:employeeId',
  canView,
  validate({ params: employeeIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await assertEmployeeInScope(auth, req.params.employeeId as string, viewScope(auth))
    return sendSuccess(res, await buildExitTaxPreview(auth.organizationId, req.params.employeeId as string))
  }),
)

/**
 * Deducts a leaver's P.Tax for the half-year from their final salary.
 *
 * The row holds the estimate until payroll calculates that month and records
 * the real figure. Setting it again for the same exit refreshes the estimate.
 */
taxRouter.post(
  '/exit-deductions/:employeeId',
  canManage,
  validate({ params: employeeIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await assertCanManageEmployee(auth, req.params.employeeId as string, manageScope(auth))
    const preview = await buildExitTaxPreview(auth.organizationId, req.params.employeeId as string)
    if (preview.employmentStatus === 'INACTIVE') {
      throw ApiError.businessRule('An inactive employee is left out of payroll, so there is no final salary to deduct P.Tax from.')
    }
    await assertPayrollOpen(auth.organizationId, preview.payrollYear, preview.payrollMonth)
    const final = { year: preview.payrollYear, month: preview.payrollMonth }

    const row = await withTransaction(async (tx) => {
      // One left in another month belonged to an earlier exit date.
      await withdrawExitTax(auth.organizationId, preview.employeeId, final, tx)
      return queryOne<TaxDeductionRow>(
        tx,
        `INSERT INTO tax_deductions
           (organization_id, employee_id, payroll_year, payroll_month, period_from, period_to,
            wage_base, tax_amount, on_exit, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)
         ON CONFLICT (employee_id, payroll_year, payroll_month, on_exit) DO UPDATE
           SET period_from = EXCLUDED.period_from,
               period_to = EXCLUDED.period_to,
               wage_base = EXCLUDED.wage_base,
               tax_amount = EXCLUDED.tax_amount,
               created_by = EXCLUDED.created_by
         RETURNING *`,
        [
          auth.organizationId,
          preview.employeeId,
          final.year,
          final.month,
          preview.periodFrom,
          preview.periodTo,
          preview.wagesSoFar,
          preview.taxSoFar,
          auth.userId,
        ],
      )
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'TAX_DEDUCTION_SET',
      entityType: 'tax_deduction',
      entityId: row?.id ?? null,
      newValues: {
        onExit: true,
        employeeId: preview.employeeId,
        exitDate: preview.exitDate,
        payrollMonth: `${final.year}-${final.month}`,
        period: `${preview.periodFrom} to ${preview.periodTo}`,
        estimate: preview.taxSoFar,
      },
    })

    const month = monthLabel(final.year, final.month)
    const recalculate =
      preview.payrollStatus === 'CALCULATED' || preview.payrollStatus === 'UNDER_REVIEW'
        ? ` Recalculate the ${month} payroll to apply it.`
        : ''
    return sendSuccess(
      res,
      row ? presentDeduction(row) : null,
      `P.Tax will be deducted from ${preview.employeeName}'s ${month} salary.${recalculate}`,
    )
  }),
)

taxRouter.delete(
  '/deductions/:id',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await queryOne<TaxDeductionRow>(
      pool,
      'SELECT * FROM tax_deductions WHERE id = $1 AND organization_id = $2',
      [req.params.id as string, auth.organizationId],
    )
    if (!existing) throw ApiError.notFound('Tax deduction')
    await assertCanManageEmployee(auth, existing.employee_id, manageScope(auth))
    await assertPayrollOpen(auth.organizationId, existing.payroll_year, existing.payroll_month)

    await pool.query('DELETE FROM tax_deductions WHERE id = $1', [existing.id])
    await recordAudit({
      ...auditContextFrom(req),
      action: 'TAX_DEDUCTION_REMOVED',
      entityType: 'tax_deduction',
      entityId: existing.id,
      oldValues: presentDeduction(existing),
    })
    return sendNoContent(res, 'Tax deduction removed')
  }),
)
