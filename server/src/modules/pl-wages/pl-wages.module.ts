import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { roundHalfUp } from '../../utils/money.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'

/**
 * PL Wages: an annual credit for earned-leave wages.
 *
 * Once a year (typically once every month of that year has been approved), an
 * admin generates the batch: for every employee with payroll that year, count
 * how many separate calendar months they worked at least 20 days in. Fewer
 * than 3 qualifying months and they are not eligible at all; otherwise the
 * credit is one day's wage for every 20 days worked across the whole year
 * (rounded to the nearest day), at the most recent daily rate actually paid
 * that year - see `dailyRateForYear` below, which reads it straight off
 * payroll rather than re-deriving it from the salary structure, so it can
 * never drift from what the employee was actually paid.
 *
 * The batch is reviewed, then released into a chosen payroll month (where
 * payroll pays it as a PL_WAGES earning - see payroll.calculator.ts), and
 * marked paid once that run has actually been settled.
 */

export interface PlWagesRow {
  id: string
  employee_id: string
  credit_year: number
  qualifying_months: number
  total_days_worked: string
  eligible_days: number
  daily_wage_rate: string
  credit_amount: string
  status: 'NOT_ELIGIBLE' | 'PENDING' | 'APPROVED' | 'PAID'
  payroll_year: number | null
  payroll_month: number | null
  paid_on: string | null
  employee_code?: string
  employee_name?: string
  department_name?: string | null
}

/** What payroll pays out for these employees in this month. */
export async function listApprovedPlWagesForPeriod(
  employeeIds: string[],
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<PlWagesRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<PlWagesRow>(
    db,
    `SELECT * FROM pl_wages_credits
      WHERE employee_id = ANY($1::uuid[]) AND payroll_year = $2 AND payroll_month = $3
        AND status IN ('APPROVED', 'PAID')`,
    [employeeIds, year, month],
  )
}

async function assertPayrollOpen(organizationId: string, year: number, month: number): Promise<void> {
  const run = await queryOne<{ status: string }>(
    pool,
    `SELECT status::text AS status FROM payroll_runs
      WHERE organization_id = $1 AND year = $2 AND month = $3 AND status IN ('APPROVED', 'LOCKED')`,
    [organizationId, year, month],
  )
  if (run) {
    throw ApiError.businessRule(
      `Payroll for ${month}/${year} is already ${run.status.toLowerCase()}, so PL Wages can no longer be released into it. Choose a later month.`,
    )
  }
}

async function findCredit(id: string, organizationId: string): Promise<PlWagesRow | null> {
  return queryOne<PlWagesRow>(
    pool,
    `SELECT c.*, e.employee_code,
            trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
            d.name AS department_name
       FROM pl_wages_credits c
       JOIN employees e ON e.id = c.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE c.id = $1 AND c.organization_id = $2`,
    [id, organizationId],
  )
}

function presentCredit(row: PlWagesRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? null,
    employeeName: row.employee_name ?? null,
    departmentName: row.department_name ?? null,
    creditYear: row.credit_year,
    qualifyingMonths: row.qualifying_months,
    totalDaysWorked: Number(row.total_days_worked),
    eligibleDays: row.eligible_days,
    dailyWageRate: Number(row.daily_wage_rate),
    creditAmount: Number(row.credit_amount),
    status: row.status,
    payrollYear: row.payroll_year,
    payrollMonth: row.payroll_month,
    paidOn: row.paid_on,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() })

const listQuerySchema = z.object({
  creditYear: z.coerce.number().int().min(1970).max(2200).optional(),
  status: z.enum(['NOT_ELIGIBLE', 'PENDING', 'APPROVED', 'PAID']).optional(),
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
})

const generateSchema = z.object({
  creditYear: z.coerce.number().int().min(1970).max(2200),
})

const approveSchema = z.object({
  payrollYear: z.coerce.number().int().min(1970).max(2200),
  payrollMonth: z.coerce.number().int().min(1).max(12),
})

export type ListQuery = z.infer<typeof listQuerySchema>
export type GenerateInput = z.infer<typeof generateSchema>
export type ApproveInput = z.infer<typeof approveSchema>

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const MIN_QUALIFYING_MONTHS = 3
const QUALIFYING_MONTH_MIN_DAYS = 20

interface YearLine {
  employee_id: string
  month: number
  days_worked: string
  gross_earnings: string
  paid_days: string
}

/** One row per employee, per month of `creditYear`, from every approved or locked run. */
async function loadYearLines(organizationId: string, creditYear: number, db: Queryable): Promise<YearLine[]> {
  return queryRows<YearLine>(
    db,
    `SELECT i.employee_id,
            r.month,
            (i.present_days + i.half_day_leave_days * 0.5) AS days_worked,
            i.gross_earnings,
            i.paid_days
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE r.organization_id = $1 AND r.year = $2 AND r.status IN ('APPROVED', 'LOCKED')
      ORDER BY i.employee_id, r.month`,
    [organizationId, creditYear],
  )
}

interface Assessment {
  employeeId: string
  qualifyingMonths: number
  totalDaysWorked: number
  eligibleDays: number
  dailyWageRate: number
  creditAmount: number
  monthsWithData: number
}

/** The pure arithmetic, once the year's payroll lines are loaded. */
export function assessEmployees(lines: YearLine[]): Assessment[] {
  const byEmployee = new Map<string, YearLine[]>()
  for (const line of lines) {
    const list = byEmployee.get(line.employee_id) ?? []
    list.push(line)
    byEmployee.set(line.employee_id, list)
  }

  return [...byEmployee.entries()].map(([employeeId, monthLines]) => {
    const totalDaysWorked = monthLines.reduce((sum, line) => sum + Number(line.days_worked), 0)
    const qualifyingMonths = monthLines.filter((line) => Number(line.days_worked) >= QUALIFYING_MONTH_MIN_DAYS).length
    const eligible = qualifyingMonths >= MIN_QUALIFYING_MONTHS
    const eligibleDays = eligible ? Math.max(roundHalfUp(totalDaysWorked / 20), 0) : 0

    // The most recent month with real paid days sets the rate, so the credit
    // reflects what the employee was actually being paid near year end.
    const latest = [...monthLines].reverse().find((line) => Number(line.paid_days) > 0)
    const dailyWageRate = latest ? Number((Number(latest.gross_earnings) / Number(latest.paid_days)).toFixed(2)) : 0

    return {
      employeeId,
      qualifyingMonths,
      totalDaysWorked: Number(totalDaysWorked.toFixed(2)),
      eligibleDays,
      dailyWageRate,
      creditAmount: eligible ? Number((eligibleDays * dailyWageRate).toFixed(2)) : 0,
      monthsWithData: monthLines.length,
    }
  })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const plWagesRouter = Router()
plWagesRouter.use(authenticate)

plWagesRouter.get(
  '/',
  requirePermissions(PERMISSIONS.PL_WAGES_VIEW),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as ListQuery

    const conditions = ['c.organization_id = $1']
    const params: unknown[] = [auth.organizationId]
    const push = (value: unknown): number => {
      params.push(value)
      return params.length
    }

    if (filters.creditYear) conditions.push(`c.credit_year = $${push(filters.creditYear)}`)
    if (filters.status) conditions.push(`c.status = $${push(filters.status)}`)
    if (filters.employeeId) conditions.push(`c.employee_id = $${push(filters.employeeId)}`)
    if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)

    const rows = await queryRows<PlWagesRow>(
      pool,
      `SELECT c.*, e.employee_code,
              trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
              d.name AS department_name
         FROM pl_wages_credits c
         JOIN employees e ON e.id = c.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.credit_year DESC, e.employee_code`,
      params,
    )
    return sendSuccess(res, rows.map(presentCredit))
  }),
)

/** Generates (or refreshes any still-PENDING/NOT_ELIGIBLE row) for every employee with payroll that year. */
plWagesRouter.post(
  '/generate',
  requirePermissions(PERMISSIONS.PL_WAGES_MANAGE),
  validate({ body: generateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as GenerateInput

    const { created, assessments } = await withTransaction(async (tx) => {
      const lines = await loadYearLines(auth.organizationId, input.creditYear, tx)
      if (lines.length === 0) {
        throw ApiError.businessRule(`There is no approved payroll for ${input.creditYear} to assess yet`)
      }
      const assessments = assessEmployees(lines)

      const rows = await queryRows<{ id: string; employee_id: string }>(
        tx,
        `INSERT INTO pl_wages_credits
           (organization_id, employee_id, credit_year, qualifying_months, total_days_worked,
            eligible_days, daily_wage_rate, credit_amount, status, created_by)
         SELECT $1::uuid, a.employee_id, $2::smallint, a.qualifying_months, a.total_days_worked,
                a.eligible_days, a.daily_wage_rate, a.credit_amount,
                CASE WHEN a.qualifying_months >= ${MIN_QUALIFYING_MONTHS} THEN 'PENDING' ELSE 'NOT_ELIGIBLE' END::pl_wages_status,
                $3::uuid
           FROM unnest($4::uuid[], $5::int[], $6::numeric[], $7::int[], $8::numeric[], $9::numeric[])
                AS a(employee_id, qualifying_months, total_days_worked, eligible_days, daily_wage_rate, credit_amount)
         ON CONFLICT (employee_id, credit_year) DO UPDATE
           SET qualifying_months = EXCLUDED.qualifying_months,
               total_days_worked = EXCLUDED.total_days_worked,
               eligible_days = EXCLUDED.eligible_days,
               daily_wage_rate = EXCLUDED.daily_wage_rate,
               credit_amount = EXCLUDED.credit_amount,
               status = EXCLUDED.status
           WHERE pl_wages_credits.status IN ('PENDING', 'NOT_ELIGIBLE')
         RETURNING id, employee_id`,
        [
          auth.organizationId,
          input.creditYear,
          auth.userId,
          assessments.map((a) => a.employeeId),
          assessments.map((a) => a.qualifyingMonths),
          assessments.map((a) => a.totalDaysWorked),
          assessments.map((a) => a.eligibleDays),
          assessments.map((a) => a.dailyWageRate),
          assessments.map((a) => a.creditAmount),
        ],
      )
      return { created: rows, assessments }
    })

    // Only rows this run actually touched (a row already APPROVED/PAID is left alone).
    const touchedEmployeeIds = new Set(created.map((row) => row.employee_id))
    const eligibleCount = assessments.filter(
      (a) => touchedEmployeeIds.has(a.employeeId) && a.qualifyingMonths >= MIN_QUALIFYING_MONTHS,
    ).length

    await recordAudit({
      ...auditContextFrom(req),
      action: 'PL_WAGES_GENERATED',
      entityType: 'pl_wages_credit',
      entityId: null,
      newValues: { creditYear: input.creditYear, rows: created.length, eligible: eligibleCount },
    })

    return sendCreated(
      res,
      { rows: created.length, eligible: eligibleCount },
      `Assessed ${created.length} employee${created.length === 1 ? '' : 's'} for ${input.creditYear} - ${eligibleCount} eligible`,
    )
  }),
)

/** Releases an eligible credit into a chosen payroll month, where it is paid as an earning. */
plWagesRouter.patch(
  '/:id/approve',
  requirePermissions(PERMISSIONS.PL_WAGES_MANAGE),
  validate({ params: idParam, body: approveSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as ApproveInput

    const existing = await findCredit(id, auth.organizationId)
    if (!existing) throw ApiError.notFound('PL Wages credit')
    if (existing.status !== 'PENDING') {
      throw ApiError.businessRule('Only a pending, eligible credit can be released into payroll')
    }
    await assertPayrollOpen(auth.organizationId, input.payrollYear, input.payrollMonth)

    const row = await queryOne<PlWagesRow>(
      pool,
      `UPDATE pl_wages_credits SET status = 'APPROVED', payroll_year = $3, payroll_month = $4
        WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, auth.organizationId, input.payrollYear, input.payrollMonth],
    )

    await recordAudit({
      ...auditContextFrom(req),
      action: 'PL_WAGES_APPROVED',
      entityType: 'pl_wages_credit',
      entityId: id,
      newValues: { payrollPeriod: `${input.payrollYear}-${input.payrollMonth}`, amount: existing.credit_amount },
    })

    return sendSuccess(res, row ? presentCredit(row) : null, 'Released into payroll')
  }),
)

plWagesRouter.patch(
  '/:id/mark-paid',
  requirePermissions(PERMISSIONS.PL_WAGES_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const existing = await findCredit(id, auth.organizationId)
    if (!existing) throw ApiError.notFound('PL Wages credit')
    if (existing.status !== 'APPROVED') {
      throw ApiError.businessRule('Only a credit released into payroll can be marked paid')
    }

    const row = await queryOne<PlWagesRow>(
      pool,
      `UPDATE pl_wages_credits SET status = 'PAID', paid_on = current_date
        WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, auth.organizationId],
    )
    await recordAudit({
      ...auditContextFrom(req),
      action: 'PL_WAGES_MARKED_PAID',
      entityType: 'pl_wages_credit',
      entityId: id,
      newValues: {},
    })
    return sendSuccess(res, row ? presentCredit(row) : null, 'Marked as paid')
  }),
)

plWagesRouter.patch(
  '/:id/mark-unpaid',
  requirePermissions(PERMISSIONS.PL_WAGES_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const existing = await findCredit(id, auth.organizationId)
    if (!existing) throw ApiError.notFound('PL Wages credit')
    if (existing.status !== 'PAID') {
      throw ApiError.businessRule('Only a credit marked paid can be reverted')
    }

    const row = await queryOne<PlWagesRow>(
      pool,
      `UPDATE pl_wages_credits SET status = 'APPROVED', paid_on = NULL
        WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, auth.organizationId],
    )
    await recordAudit({
      ...auditContextFrom(req),
      action: 'PL_WAGES_MARKED_UNPAID',
      entityType: 'pl_wages_credit',
      entityId: id,
      newValues: {},
    })
    return sendSuccess(res, row ? presentCredit(row) : null, 'Marked as not paid')
  }),
)

plWagesRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.PL_WAGES_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findCredit(req.params.id as string, auth.organizationId)
    if (!existing) throw ApiError.notFound('PL Wages credit')
    if (existing.status === 'APPROVED' || existing.status === 'PAID') {
      throw ApiError.businessRule('A credit already released into payroll cannot be deleted')
    }

    await pool.query('DELETE FROM pl_wages_credits WHERE id = $1', [existing.id])
    await recordAudit({
      ...auditContextFrom(req),
      action: 'PL_WAGES_DELETED',
      entityType: 'pl_wages_credit',
      entityId: existing.id,
      oldValues: presentCredit(existing),
    })
    return sendNoContent(res, 'PL Wages row removed')
  }),
)
