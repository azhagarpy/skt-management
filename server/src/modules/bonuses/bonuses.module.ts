import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { buildUpdate } from '../organization/organization.repository.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { firstDayOfMonth, lastDayOfMonth, todayIso, type IsoDate } from '../../utils/dates.js'
import {
  buildStatement,
  statementQuerySchema,
  toStatementExcel,
  type StatementQuery,
} from './bonus-statement.js'

/**
 * Bonuses (plan section 25).
 *
 * A bonus is a name and an amount given to one or many employees, either picked
 * one by one or everyone in a department. The amount is either fixed, or a
 * percentage of the wages each person earned over a range of payroll months
 * (see bonus-statement.ts). It is attached to a payroll
 * month rather than a date, so the payroll engine can pick up everything due for
 * the month it is calculating. Only APPROVED bonuses are paid; PENDING ones are
 * ignored by the calculator.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const bonusStatusSchema = z.enum(['PENDING', 'APPROVED', 'PAID', 'CANCELLED'])

const bonusFieldsSchema = z.object({
  bonusName: z.string().trim().min(2, 'A bonus name is required').max(120),
  amount: z.coerce.number().gt(0, 'Enter a bonus amount greater than zero').max(99_999_999),
  bonusDate: isoDateSchema.default(() => todayIso()),
  payrollYear: z.coerce.number().int().min(1970).max(2200),
  payrollMonth: z.coerce.number().int().min(1).max(12),
  reason: z.string().trim().max(300).nullish(),
  status: bonusStatusSchema.default('APPROVED'),
})

/**
 * Who receives the bonus (an explicit list, or every active employee in a
 * department - exactly one of the two) and how the amount is decided.
 */
export const bonusSchema = bonusFieldsSchema
  .omit({ amount: true })
  .extend({
    employeeIds: z.array(z.string().uuid()).max(2000).optional(),
    departmentId: z.string().uuid().optional(),
    calculation: z.enum(['FIXED', 'PERCENT_OF_WAGES']).default('FIXED'),
    /** FIXED: the amount each person gets. */
    amount: z.coerce.number().max(99_999_999).optional(),
    /** PERCENT_OF_WAGES: the share of total wages, over the range below. */
    percentage: z.coerce.number().gt(0, 'Enter a percentage greater than zero').max(100).optional(),
    fromYear: z.coerce.number().int().min(1970).max(2200).optional(),
    fromMonth: z.coerce.number().int().min(1).max(12).optional(),
    toYear: z.coerce.number().int().min(1970).max(2200).optional(),
    toMonth: z.coerce.number().int().min(1).max(12).optional(),
    /** Anyone with fewer man days than this over the range gets nothing. */
    minManDays: z.coerce.number().min(0).max(366).default(0),
  })
  .superRefine((value, ctx) => {
    const hasEmployees = (value.employeeIds?.length ?? 0) > 0
    if (hasEmployees === Boolean(value.departmentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['employeeIds'],
        message: 'Choose employees, or choose a department - not both',
      })
    }

    if (value.calculation === 'FIXED') {
      if (!value.amount || value.amount <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Enter a bonus amount greater than zero' })
      }
      return
    }

    if (!value.percentage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percentage'], message: 'Enter a percentage greater than zero' })
    }
    const range = statementQuerySchema.safeParse({
      fromYear: value.fromYear,
      fromMonth: value.fromMonth,
      toYear: value.toYear,
      toMonth: value.toMonth,
      percentage: value.percentage ?? 1,
    })
    if (!range.success) {
      for (const issue of range.error.issues) ctx.addIssue({ ...issue })
    }
  })

export const bonusUpdateSchema = bonusFieldsSchema.partial()

export const bonusListQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  payrollYear: z.coerce.number().int().min(1970).max(2200).optional(),
  payrollMonth: z.coerce.number().int().min(1).max(12).optional(),
  status: bonusStatusSchema.optional(),
  departmentId: z.string().uuid().optional(),
})

export type BonusInput = z.infer<typeof bonusSchema>
export type BonusListQuery = z.infer<typeof bonusListQuerySchema>

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface BonusRow {
  id: string
  employee_id: string
  bonus_name: string
  amount_type: 'FIXED_AMOUNT' | 'PERCENTAGE'
  amount: string
  percentage: string
  bonus_date: IsoDate
  payroll_year: number
  payroll_month: number
  reason: string | null
  status: string
  employee_code?: string
  first_name?: string
  last_name?: string | null
  department_name?: string | null
  wage_percentage: string | null
  wage_base: string | null
  man_days: string | null
  wage_period_from: IsoDate | null
  wage_period_to: IsoDate | null
}

const BONUS_SELECT = `
  SELECT b.*, e.employee_code, e.first_name, e.last_name, d.name AS department_name
    FROM employee_bonuses b
    JOIN employees e ON e.id = b.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
`

export async function listApprovedBonusesForPeriod(
  employeeIds: string[],
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<BonusRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<BonusRow>(
    db,
    `${BONUS_SELECT}
      WHERE b.employee_id = ANY($1::uuid[])
        AND b.payroll_year = $2
        AND b.payroll_month = $3
        AND b.status IN ('APPROVED', 'PAID')`,
    [employeeIds, year, month],
  )
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() })

function presentBonus(row: BonusRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? null,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    departmentName: row.department_name ?? null,
    bonusName: row.bonus_name,
    amount: Number(row.amount),
    bonusDate: row.bonus_date,
    payrollYear: row.payroll_year,
    payrollMonth: row.payroll_month,
    reason: row.reason,
    status: row.status,
    // Present only for a bonus worked out as a percentage of wages.
    wagePercentage: row.wage_percentage === null ? null : Number(row.wage_percentage),
    wageBase: row.wage_base === null ? null : Number(row.wage_base),
    manDays: row.man_days === null ? null : Number(row.man_days),
    wagePeriodFrom: row.wage_period_from,
    wagePeriodTo: row.wage_period_to,
  }
}

export const bonusRouter = Router()
bonusRouter.use(authenticate)

/** The month-by-month wages and the bonus a percentage of them comes to. */
bonusRouter.get(
  '/statement',
  requirePermissions(PERMISSIONS.BONUS_VIEW),
  validate({ query: statementQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const statement = await buildStatement({ organizationId: auth.organizationId }, req.query as unknown as StatementQuery)
    return sendSuccess(res, statement)
  }),
)

bonusRouter.get(
  '/statement/export',
  requirePermissions(PERMISSIONS.BONUS_VIEW, PERMISSIONS.REPORT_EXPORT),
  validate({ query: statementQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as StatementQuery
    const statement = await buildStatement({ organizationId: auth.organizationId }, query)

    const organization = await queryOne<{ name: string }>(pool, 'SELECT name FROM organizations WHERE id = $1', [
      auth.organizationId,
    ])
    const buffer = await toStatementExcel(statement, organization?.name ?? 'Organization')

    await recordAudit({
      ...auditContextFrom(req),
      action: 'REPORT_EXPORTED',
      entityType: 'report',
      entityId: null,
      newValues: { report: 'bonus-statement', format: 'xlsx', rows: statement.rows.length },
    })

    const filename = `bonus-${query.fromYear}-${String(query.fromMonth).padStart(2, '0')}-to-${query.toYear}-${String(query.toMonth).padStart(2, '0')}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(buffer)
  }),
)

bonusRouter.get(
  '/',
  requirePermissions(PERMISSIONS.BONUS_VIEW),
  validate({ query: bonusListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as BonusListQuery

    const conditions = ['e.organization_id = $1']
    const params: unknown[] = [auth.organizationId]
    const push = (value: unknown): number => {
      params.push(value)
      return params.length
    }

    if (filters.employeeId) conditions.push(`b.employee_id = $${push(filters.employeeId)}`)
    if (filters.payrollYear) conditions.push(`b.payroll_year = $${push(filters.payrollYear)}`)
    if (filters.payrollMonth) conditions.push(`b.payroll_month = $${push(filters.payrollMonth)}`)
    if (filters.status) conditions.push(`b.status = $${push(filters.status)}`)
    if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)

    const rows = await queryRows<BonusRow>(
      pool,
      `${BONUS_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY b.payroll_year DESC, b.payroll_month DESC, e.employee_code`,
      params,
    )
    return sendSuccess(res, rows.map(presentBonus))
  }),
)

bonusRouter.post(
  '/',
  requirePermissions(PERMISSIONS.BONUS_MANAGE),
  validate({ body: bonusSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as BonusInput

    // A locked payroll must not gain new earnings after the fact.
    const lockedRun = await queryOne<{ id: string; status: string }>(
      pool,
      `SELECT id, status::text AS status FROM payroll_runs
        WHERE organization_id = $1 AND year = $2 AND month = $3 AND status IN ('APPROVED', 'LOCKED')`,
      [auth.organizationId, input.payrollYear, input.payrollMonth],
    )
    if (lockedRun) {
      throw ApiError.businessRule(
        `Payroll for ${input.payrollMonth}/${input.payrollYear} is already ${lockedRun.status.toLowerCase()}. Raise a payroll adjustment instead.`,
      )
    }

    // Resolve the recipients inside the organization, so an id from elsewhere
    // can never receive a bonus here.
    let employeeIds: string[]
    if (input.departmentId) {
      const rows = await queryRows<{ id: string }>(
        pool,
        `SELECT id FROM employees
          WHERE organization_id = $1 AND department_id = $2 AND employment_status = 'ACTIVE'`,
        [auth.organizationId, input.departmentId],
      )
      employeeIds = rows.map((row) => row.id)
      if (employeeIds.length === 0) {
        throw ApiError.businessRule('There are no active employees in that department')
      }
    } else {
      const requested = [...new Set(input.employeeIds ?? [])]
      const rows = await queryRows<{ id: string }>(
        pool,
        'SELECT id FROM employees WHERE organization_id = $1 AND id = ANY($2::uuid[])',
        [auth.organizationId, requested],
      )
      if (rows.length !== requested.length) throw ApiError.notFound('Employee')
      employeeIds = requested
    }

    // One row per person who actually gets a bonus, with how it was worked out.
    interface Award {
      employeeId: string
      amount: number
      wageBase: number | null
      manDays: number | null
    }
    let awards: Award[]
    let notEligible = 0
    const isPercent = input.calculation === 'PERCENT_OF_WAGES'

    if (isPercent) {
      const statement = await buildStatement(
        { organizationId: auth.organizationId, employeeIds },
        {
          fromYear: input.fromYear as number,
          fromMonth: input.fromMonth as number,
          toYear: input.toYear as number,
          toMonth: input.toMonth as number,
          percentage: input.percentage as number,
          minManDays: input.minManDays,
        },
      )
      const byEmployee = new Map(statement.rows.map((row) => [row.employeeId, row]))
      awards = []
      for (const id of employeeIds) {
        const row = byEmployee.get(id)
        if (row?.eligible && row.bonus > 0) {
          awards.push({ employeeId: id, amount: row.bonus, wageBase: row.totalWages, manDays: row.totalManDays })
        } else {
          notEligible += 1
        }
      }
      if (awards.length === 0) {
        throw ApiError.businessRule(
          'Nobody qualifies: there are no wages in those payroll months, or everyone is below the minimum man days.',
        )
      }
    } else {
      awards = employeeIds.map((employeeId) => ({ employeeId, amount: input.amount as number, wageBase: null, manDays: null }))
    }

    // One statement, so either every recipient gets the bonus or nobody does.
    const created = await queryRows<{ id: string }>(
      pool,
      `INSERT INTO employee_bonuses
         (organization_id, employee_id, bonus_name, amount_type, amount, percentage, bonus_date,
          payroll_year, payroll_month, reason, status, approved_by, approved_at, created_by,
          wage_percentage, wage_base, man_days, wage_period_from, wage_period_to)
       SELECT $1::uuid, award.employee_id, $3::text, 'FIXED_AMOUNT', award.amount, 0, $4::date,
              $5::smallint, $6::smallint, $7::text, $8::text::bonus_status,
              CASE WHEN $8::text = 'APPROVED' THEN $9::uuid ELSE NULL END,
              CASE WHEN $8::text = 'APPROVED' THEN now() ELSE NULL END,
              $9::uuid,
              $10::numeric, award.wage_base, award.man_days, $11::date, $12::date
         FROM unnest($2::uuid[], $13::numeric[], $14::numeric[], $15::numeric[])
              AS award(employee_id, amount, wage_base, man_days)
       RETURNING id`,
      [
        auth.organizationId,
        awards.map((award) => award.employeeId),
        input.bonusName,
        input.bonusDate,
        input.payrollYear,
        input.payrollMonth,
        input.reason ?? null,
        input.status,
        auth.userId,
        isPercent ? input.percentage : null,
        isPercent ? firstDayOfMonth(input.fromYear as number, input.fromMonth as number) : null,
        isPercent ? lastDayOfMonth(input.toYear as number, input.toMonth as number) : null,
        awards.map((award) => award.amount),
        awards.map((award) => award.wageBase),
        awards.map((award) => award.manDays),
      ],
    )

    await recordAudit({
      ...auditContextFrom(req),
      action: 'BONUS_ADDED',
      entityType: 'employee_bonus',
      entityId: created.length === 1 ? (created[0]?.id ?? null) : null,
      newValues: {
        bonusName: input.bonusName,
        calculation: input.calculation,
        ...(isPercent
          ? {
              percentage: input.percentage,
              wagePeriod: `${input.fromYear}-${input.fromMonth} to ${input.toYear}-${input.toMonth}`,
              minManDays: input.minManDays,
              total: awards.reduce((sum, award) => sum + award.amount, 0),
            }
          : { amount: input.amount }),
        employees: created.length,
        departmentId: input.departmentId ?? null,
        period: `${input.payrollYear}-${input.payrollMonth}`,
      },
    })

    const skippedNote =
      notEligible > 0 ? ` (${notEligible} skipped: no wages in the range or below ${input.minManDays} man days)` : ''
    return sendCreated(
      res,
      { count: created.length, skipped: notEligible },
      created.length === 1
        ? `Bonus added successfully${skippedNote}`
        : `Bonus added for ${created.length} employees${skippedNote}`,
    )
  }),
)

bonusRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.BONUS_MANAGE),
  validate({ params: idParam, body: bonusUpdateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as Partial<z.infer<typeof bonusFieldsSchema>>

    const existing = await queryOne<BonusRow>(
      pool,
      'SELECT * FROM employee_bonuses WHERE id = $1 AND organization_id = $2',
      [id, auth.organizationId],
    )
    if (!existing) throw ApiError.notFound('Bonus')
    if (existing.status === 'PAID') {
      throw ApiError.businessRule('A bonus that has been paid cannot be edited. Raise a payroll adjustment instead.')
    }

    const { assignments, params } = buildUpdate(
      {
        bonus_name: input.bonusName,
        amount: input.amount,
        // Editing the amount by hand means it no longer follows from the wages.
        ...(input.amount === undefined
          ? {}
          : { wage_percentage: null, wage_base: null, man_days: null, wage_period_from: null, wage_period_to: null }),
        bonus_date: input.bonusDate,
        payroll_year: input.payrollYear,
        payroll_month: input.payrollMonth,
        reason: input.reason,
        status: input.status,
      },
      3,
    )
    if (assignments.length === 0) return sendSuccess(res, presentBonus(existing))

    const row = await queryOne<BonusRow>(
      pool,
      `UPDATE employee_bonuses SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, auth.organizationId, ...params],
    )

    await recordAudit({
      ...auditContextFrom(req),
      action: 'BONUS_UPDATED',
      entityType: 'employee_bonus',
      entityId: id,
      oldValues: { amount: Number(existing.amount), status: existing.status },
      newValues: { amount: input.amount, status: input.status },
    })

    return sendSuccess(res, row ? presentBonus(row) : null, 'Bonus updated successfully')
  }),
)

bonusRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.BONUS_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string

    const existing = await queryOne<BonusRow>(
      pool,
      'SELECT * FROM employee_bonuses WHERE id = $1 AND organization_id = $2',
      [id, auth.organizationId],
    )
    if (!existing) throw ApiError.notFound('Bonus')
    if (existing.status === 'PAID') {
      throw ApiError.businessRule('A bonus that has been paid cannot be deleted. Raise a payroll adjustment instead.')
    }

    await pool.query('DELETE FROM employee_bonuses WHERE id = $1 AND organization_id = $2', [id, auth.organizationId])

    await recordAudit({
      ...auditContextFrom(req),
      action: 'BONUS_DELETED',
      entityType: 'employee_bonus',
      entityId: id,
      oldValues: presentBonus(existing),
    })

    return sendNoContent(res, 'Bonus deleted successfully')
  }),
)
