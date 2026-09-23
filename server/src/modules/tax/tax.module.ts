import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { firstDayOfMonth, lastDayOfMonth, type IsoDate } from '../../utils/dates.js'
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

/**
 * Tax: the tax amount for each band of wages, and the report that applies the
 * bands to what each employee earned over a period (see tax-report.ts).
 *
 * The administrator then chooses the payroll month the tax comes out of pay.
 * That choice is stored per employee (tax_deductions) with the wages it was
 * worked out on, and payroll deducts it as a "P.Tax" line when it calculates that
 * month.
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
  }
}

async function presentSlabs(organizationId: string) {
  const slabs = await loadSlabs(organizationId)
  const labels = slabLabels(slabs)
  return slabs.map((slab, index) => ({ ...slab, label: labels[index] ?? '' }))
}

export const taxRouter = Router()
taxRouter.use(authenticate)

taxRouter.get(
  '/slabs',
  requirePermissions(PERMISSIONS.TAX_VIEW),
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
  requirePermissions(PERMISSIONS.TAX_VIEW),
  validate({ query: taxReportQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await buildTaxReport(auth.organizationId, req.query as unknown as TaxReportQuery))
  }),
)

taxRouter.get(
  '/report/export',
  requirePermissions(PERMISSIONS.TAX_VIEW, PERMISSIONS.REPORT_EXPORT),
  validate({ query: taxReportQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as TaxReportQuery
    const report = await buildTaxReport(auth.organizationId, query)

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
  requirePermissions(PERMISSIONS.TAX_VIEW),
  validate({ query: deductionListSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as z.infer<typeof deductionListSchema>
    const params: unknown[] = [auth.organizationId, query.payrollYear]
    let month = ''
    if (query.payrollMonth) {
      params.push(query.payrollMonth)
      month = `AND t.payroll_month = $${params.length}`
    }
    const rows = await queryRows<TaxDeductionRow>(
      pool,
      `SELECT t.*, e.employee_code,
              trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
              d.name AS department_name
         FROM tax_deductions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE t.organization_id = $1 AND t.payroll_year = $2 ${month}
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
 */
taxRouter.post(
  '/deductions',
  requirePermissions(PERMISSIONS.TAX_MANAGE),
  validate({ body: taxDeductSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as TaxDeductInput
    await assertPayrollOpen(auth.organizationId, input.payrollYear, input.payrollMonth)

    const report = await buildTaxReport(auth.organizationId, input)
    const rows = report.groups.flatMap((group) => group.rows)
    if (rows.length === 0) {
      throw ApiError.businessRule('There is no payroll in that period, so there is no tax to deduct.')
    }
    if (report.slabs.length === 0) {
      throw ApiError.businessRule('Set the tax slabs first - with none, the tax is zero for everyone.')
    }

    const periodFrom = firstDayOfMonth(input.fromYear, input.fromMonth)
    const periodTo = lastDayOfMonth(input.toYear, input.toMonth)
    const charged = rows.filter((row) => row.tax > 0)
    const cleared = rows.filter((row) => row.tax <= 0)

    await withTransaction(async (tx) => {
      for (const row of charged) {
        await tx.query(
          `INSERT INTO tax_deductions
             (organization_id, employee_id, payroll_year, payroll_month, period_from, period_to,
              wage_base, tax_amount, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (employee_id, payroll_year, payroll_month) DO UPDATE
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
              AND employee_id = ANY($4::uuid[])`,
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
      },
    })

    return sendSuccess(
      res,
      { employees: charged.length, total, noTax: cleared.length },
      `Tax of ${total} will be deducted from ${charged.length} employee${charged.length === 1 ? '' : 's'} in ${input.payrollMonth}/${input.payrollYear}`,
    )
  }),
)

taxRouter.delete(
  '/deductions/:id',
  requirePermissions(PERMISSIONS.TAX_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await queryOne<TaxDeductionRow>(
      pool,
      'SELECT * FROM tax_deductions WHERE id = $1 AND organization_id = $2',
      [req.params.id as string, auth.organizationId],
    )
    if (!existing) throw ApiError.notFound('Tax deduction')
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
