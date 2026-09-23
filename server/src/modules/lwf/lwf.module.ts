import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { uploadPaymentProof } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { storage } from '../documents/storage.service.js'
import { sanitiseFilename, sniffContentType, extensionForType } from '../../utils/files.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'

/**
 * Labour Welfare Fund.
 *
 * A small statutory contribution collected once a year: a fixed amount from
 * the employee (deducted through payroll, exactly like P.Tax - see
 * payroll.calculator.ts) plus a matching amount from the employer, which is
 * never deducted from anyone's pay - it is tracked here only, because the
 * whole point of this module is remembering what must be remitted to the
 * government and whether that has happened yet.
 *
 * An admin generates one row per active employee for a year in one action,
 * choosing the payroll month the employee's share comes out of pay. Payroll
 * then reads whatever rows exist for that month exactly like it reads tax
 * deductions. Once the org has actually paid the government, marking a row
 * PAID (with a reference number and, optionally, a proof document) is a
 * separate, manual step - nothing here talks to a government system.
 */

const PROOF_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg'])

export interface LwfRow {
  id: string
  employee_id: string
  contribution_year: number
  employee_amount: string
  employer_amount: string
  payroll_year: number
  payroll_month: number
  status: 'PENDING' | 'PAID'
  paid_on: string | null
  reference_number: string | null
  proof_path: string | null
  proof_mime_type: string | null
  proof_filename: string | null
  employee_code?: string
  employee_name?: string
  department_name?: string | null
}

/** What payroll deducts for these employees in this month. */
export async function listLwfForPeriod(
  employeeIds: string[],
  year: number,
  month: number,
  db: Queryable = pool,
): Promise<LwfRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<LwfRow>(
    db,
    `SELECT * FROM lwf_contributions
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
      `Payroll for ${month}/${year} is already ${run.status.toLowerCase()}, so LWF can no longer be deducted in it. Choose a later month.`,
    )
  }
}

async function findLwf(id: string, organizationId: string): Promise<LwfRow | null> {
  return queryOne<LwfRow>(
    pool,
    `SELECT l.*, e.employee_code,
            trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
            d.name AS department_name
       FROM lwf_contributions l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE l.id = $1 AND l.organization_id = $2`,
    [id, organizationId],
  )
}

function presentLwf(row: LwfRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? null,
    employeeName: row.employee_name ?? null,
    departmentName: row.department_name ?? null,
    contributionYear: row.contribution_year,
    employeeAmount: Number(row.employee_amount),
    employerAmount: Number(row.employer_amount),
    totalAmount: Number(row.employee_amount) + Number(row.employer_amount),
    payrollYear: row.payroll_year,
    payrollMonth: row.payroll_month,
    status: row.status,
    paidOn: row.paid_on,
    referenceNumber: row.reference_number,
    hasProof: row.proof_path !== null,
    proofFilename: row.proof_filename,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() })

const listQuerySchema = z.object({
  contributionYear: z.coerce.number().int().min(1970).max(2200).optional(),
  payrollYear: z.coerce.number().int().min(1970).max(2200).optional(),
  payrollMonth: z.coerce.number().int().min(1).max(12).optional(),
  status: z.enum(['PENDING', 'PAID']).optional(),
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
})

const generateSchema = z.object({
  contributionYear: z.coerce.number().int().min(1970).max(2200),
  payrollYear: z.coerce.number().int().min(1970).max(2200),
  payrollMonth: z.coerce.number().int().min(1).max(12),
  employeeAmount: z.coerce.number().min(0).max(99_999).default(20),
  employerAmount: z.coerce.number().min(0).max(99_999).default(40),
})

const markPaidSchema = z.object({
  paidOn: isoDateSchema,
  referenceNumber: z.string().trim().min(1).max(120),
})

export type GenerateInput = z.infer<typeof generateSchema>
export type MarkPaidInput = z.infer<typeof markPaidSchema>
export type LwfListQuery = z.infer<typeof listQuerySchema>

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const lwfRouter = Router()
lwfRouter.use(authenticate)

lwfRouter.get(
  '/',
  requirePermissions(PERMISSIONS.LWF_VIEW),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as LwfListQuery

    const conditions = ['l.organization_id = $1']
    const params: unknown[] = [auth.organizationId]
    const push = (value: unknown): number => {
      params.push(value)
      return params.length
    }

    if (filters.contributionYear) conditions.push(`l.contribution_year = $${push(filters.contributionYear)}`)
    if (filters.payrollYear) conditions.push(`l.payroll_year = $${push(filters.payrollYear)}`)
    if (filters.payrollMonth) conditions.push(`l.payroll_month = $${push(filters.payrollMonth)}`)
    if (filters.status) conditions.push(`l.status = $${push(filters.status)}`)
    if (filters.employeeId) conditions.push(`l.employee_id = $${push(filters.employeeId)}`)
    if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)

    const rows = await queryRows<LwfRow>(
      pool,
      `SELECT l.*, e.employee_code,
              trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
              d.name AS department_name
         FROM lwf_contributions l
         JOIN employees e ON e.id = l.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.contribution_year DESC, e.employee_code`,
      params,
    )
    return sendSuccess(res, rows.map(presentLwf))
  }),
)

/**
 * Generates one row per active employee for the chosen year, skipping anyone
 * who already has one (so re-running after adding a few new joiners never
 * disturbs rows that are already paid or mid-review).
 */
lwfRouter.post(
  '/generate',
  requirePermissions(PERMISSIONS.LWF_MANAGE),
  validate({ body: generateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as GenerateInput
    await assertPayrollOpen(auth.organizationId, input.payrollYear, input.payrollMonth)

    const employees = await queryRows<{ id: string }>(
      pool,
      `SELECT id FROM employees WHERE organization_id = $1 AND employment_status = 'ACTIVE'`,
      [auth.organizationId],
    )
    if (employees.length === 0) {
      throw ApiError.businessRule('There are no active employees to generate Labour Welfare Fund rows for')
    }

    const created = await withTransaction(async (tx) =>
      queryRows<{ id: string }>(
        tx,
        `INSERT INTO lwf_contributions
           (organization_id, employee_id, contribution_year, employee_amount, employer_amount,
            payroll_year, payroll_month, created_by)
         SELECT $1::uuid, emp.id, $2::smallint, $3::numeric, $4::numeric, $5::smallint, $6::smallint, $7::uuid
           FROM unnest($8::uuid[]) AS emp(id)
         ON CONFLICT (employee_id, contribution_year) DO NOTHING
         RETURNING id`,
        [
          auth.organizationId,
          input.contributionYear,
          input.employeeAmount,
          input.employerAmount,
          input.payrollYear,
          input.payrollMonth,
          auth.userId,
          employees.map((employee) => employee.id),
        ],
      ),
    )

    await recordAudit({
      ...auditContextFrom(req),
      action: 'LWF_GENERATED',
      entityType: 'lwf_contribution',
      entityId: null,
      newValues: {
        contributionYear: input.contributionYear,
        payrollPeriod: `${input.payrollYear}-${input.payrollMonth}`,
        created: created.length,
        skipped: employees.length - created.length,
      },
    })

    return sendCreated(
      res,
      { created: created.length, skipped: employees.length - created.length },
      `Generated Labour Welfare Fund for ${created.length} employee${created.length === 1 ? '' : 's'}${
        employees.length - created.length > 0 ? ` (${employees.length - created.length} already had a row for ${input.contributionYear})` : ''
      }`,
    )
  }),
)

lwfRouter.patch(
  '/:id/mark-paid',
  requirePermissions(PERMISSIONS.LWF_MANAGE),
  // multer runs first so a multipart body (the form with a reference document) is parsed;
  // a plain JSON request passes straight through it.
  uploadPaymentProof,
  validate({ params: idParam, body: markPaidSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const id = req.params.id as string
    const input = req.body as MarkPaidInput

    const existing = await findLwf(id, auth.organizationId)
    if (!existing) throw ApiError.notFound('Labour Welfare Fund contribution')

    let proof: { key: string; contentType: string; filename: string } | null = null
    if (req.file) {
      const contentType = sniffContentType(req.file.buffer)
      if (!contentType || !PROOF_TYPES.has(contentType)) {
        throw ApiError.badRequest('The reference document must be a PDF, PNG or JPEG file')
      }
      const key = `${auth.organizationId}/lwf-proof/${id}-${randomUUID()}.${extensionForType(contentType)}`
      await storage.put(key, req.file.buffer, contentType)
      proof = { key, contentType, filename: sanitiseFilename(req.file.originalname) }
    }

    const row = await queryOne<LwfRow>(
      pool,
      `UPDATE lwf_contributions
          SET status = 'PAID', paid_on = $3, reference_number = $4, paid_by = $5
              ${proof ? ', proof_path = $6, proof_mime_type = $7, proof_filename = $8' : ''}
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      proof
        ? [id, auth.organizationId, input.paidOn, input.referenceNumber, auth.userId, proof.key, proof.contentType, proof.filename]
        : [id, auth.organizationId, input.paidOn, input.referenceNumber, auth.userId],
    )

    if (proof && existing.proof_path && existing.proof_path !== proof.key) {
      await storage.delete(existing.proof_path).catch(() => {})
    }

    await recordAudit({
      ...auditContextFrom(req),
      action: 'LWF_MARKED_PAID',
      entityType: 'lwf_contribution',
      entityId: id,
      newValues: { paidOn: input.paidOn, referenceNumber: input.referenceNumber, hasProof: Boolean(proof) },
    })

    return sendSuccess(res, row ? presentLwf(row) : null, 'Marked as paid')
  }),
)

lwfRouter.get(
  '/:id/proof',
  requirePermissions(PERMISSIONS.LWF_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findLwf(req.params.id as string, auth.organizationId)
    if (!existing) throw ApiError.notFound('Labour Welfare Fund contribution')
    if (!existing.proof_path) throw ApiError.notFound('Reference document')

    const buffer = await storage.get(existing.proof_path)
    res.setHeader('Content-Type', existing.proof_mime_type ?? 'application/octet-stream')
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${existing.proof_filename ?? 'lwf-reference'}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(buffer)
  }),
)

lwfRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.LWF_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findLwf(req.params.id as string, auth.organizationId)
    if (!existing) throw ApiError.notFound('Labour Welfare Fund contribution')
    if (existing.status === 'PAID') {
      throw ApiError.businessRule('A contribution already marked paid cannot be deleted')
    }
    await assertPayrollOpen(auth.organizationId, existing.payroll_year, existing.payroll_month)

    await pool.query('DELETE FROM lwf_contributions WHERE id = $1', [existing.id])
    if (existing.proof_path) await storage.delete(existing.proof_path).catch(() => {})

    await recordAudit({
      ...auditContextFrom(req),
      action: 'LWF_DELETED',
      entityType: 'lwf_contribution',
      entityId: existing.id,
      oldValues: presentLwf(existing),
    })
    return sendNoContent(res, 'Labour Welfare Fund row removed')
  }),
)
