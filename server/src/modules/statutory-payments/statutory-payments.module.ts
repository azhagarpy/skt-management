import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { uploadPaymentProof } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { monthLabel, type IsoDate } from '../../utils/dates.js'
import { toMinor, toNumericString, type Minor } from '../../utils/money.js'
import { extensionForType, sanitiseFilename, sniffContentType } from '../../utils/files.js'
import { logger } from '../../utils/logger.js'
import { storage } from '../documents/storage.service.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as payrollRepository from '../payroll/payroll.repository.js'

/**
 * PF and ESI remittances.
 *
 * Every payroll run owes EPFO and ESIC its PF and ESI: the employees' shares
 * deducted from pay plus the employer's contribution on top. This module shows
 * what each run owes, worked out from the run's own components, and keeps the
 * challans that paid it - any number per scheme, each with its number, date,
 * amount and proof of payment, which is required. Whether a scheme is paid
 * follows from them, as a salary's payment status follows from its payments.
 * Nothing here talks to a government system.
 *
 * Remitting is company-wide by nature, so it takes the organization-wide
 * payment permissions rather than the team ones.
 */

type Scheme = 'PF' | 'ESI'

const SCHEMES: Record<Scheme, { label: string; employeeCodes: string[]; employerCodes: string[] }> = {
  PF: { label: 'Provident Fund', employeeCodes: ['PF_EMPLOYEE'], employerCodes: ['PF_EMPLOYER_EPF', 'PF_EMPLOYER_EPS'] },
  ESI: { label: 'ESI', employeeCodes: ['ESI_EMPLOYEE'], employerCodes: ['ESI_EMPLOYER'] },
}

const PROOF_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg'])

export type SchemeStatus = 'PAID' | 'PARTIALLY_PAID' | 'PENDING' | 'NOT_DUE'

/**
 * A scheme's status for a run: PAID once its challans cover what is due - a
 * challan may carry more, such as PF admin charges - PARTIALLY_PAID while they
 * fall short, PENDING with none yet, and NOT_DUE when the run owes nothing.
 */
export function schemeStatus(dueMinor: Minor, paidMinor: Minor, challans: number): SchemeStatus {
  if (challans === 0) return dueMinor > 0 ? 'PENDING' : 'NOT_DUE'
  return paidMinor >= dueMinor ? 'PAID' : 'PARTIALLY_PAID'
}

interface ChallanRow {
  id: string
  payroll_run_id: string
  scheme: Scheme
  amount: string
  paid_on: IsoDate
  challan_number: string | null
  notes: string | null
  proof_path: string
  proof_filename: string
  proof_mime_type: string
  uploaded_by_name?: string | null
  created_at: Date
}

const runParam = z.object({ runId: z.string().uuid() })
const schemeParam = runParam.extend({ scheme: z.enum(['PF', 'ESI']) })
const challanParam = z.object({ challanId: z.string().uuid() })

// Arrives as multipart form data, so every field is a string.
const challanSchema = z.object({
  amount: z.coerce.number().positive('The amount paid must be greater than zero').max(99_999_999),
  paidOn: isoDateSchema,
  challanNumber: z.string().trim().min(1, 'Enter the challan / TRRN number').max(120),
  notes: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((value) => (value ? value : null)),
})

type ChallanInput = z.infer<typeof challanSchema>

function presentChallan(row: ChallanRow) {
  return {
    id: row.id,
    amount: Number(row.amount),
    paidOn: row.paid_on,
    challanNumber: row.challan_number,
    notes: row.notes,
    // The storage key is never sent; the file is fetched through the API.
    proofFilename: row.proof_filename,
    uploadedByName: row.uploaded_by_name ?? null,
    createdAt: row.created_at,
  }
}

const SELECT_CHALLAN = `
  SELECT c.*, u.full_name AS uploaded_by_name
    FROM payroll_statutory_challans c
    LEFT JOIN users u ON u.id = c.uploaded_by
`

async function findChallan(id: string, organizationId: string): Promise<ChallanRow> {
  const row = await queryOne<ChallanRow>(pool, `${SELECT_CHALLAN} WHERE c.id = $1 AND c.organization_id = $2`, [
    id,
    organizationId,
  ])
  if (!row) throw ApiError.notFound('Challan')
  return row
}

async function findRunOrThrow(runId: string, organizationId: string): Promise<payrollRepository.PayrollRunRow> {
  const run = await payrollRepository.findRun(runId, organizationId)
  if (!run) throw ApiError.notFound('Payroll run')
  return run
}

/** What a run owes one scheme, from its items' components. */
async function schemeDues(runId: string, scheme: Scheme) {
  const { employeeCodes, employerCodes } = SCHEMES[scheme]
  const row = await queryOne<{ employees: string; employee_share: string; employer_share: string }>(
    pool,
    `SELECT count(DISTINCT i.id) FILTER (WHERE c.amount > 0)::text AS employees,
            coalesce(sum(c.amount) FILTER (WHERE c.component_code = ANY($2::text[])), 0)::text AS employee_share,
            coalesce(sum(c.amount) FILTER (WHERE c.component_code = ANY($3::text[])), 0)::text AS employer_share
       FROM payroll_items i
       JOIN payroll_item_components c ON c.payroll_item_id = i.id
      WHERE i.payroll_run_id = $1 AND c.component_code = ANY($4::text[])`,
    [runId, employeeCodes, employerCodes, [...employeeCodes, ...employerCodes]],
  )
  const employeeShareMinor = toMinor(row?.employee_share ?? 0)
  const employerShareMinor = toMinor(row?.employer_share ?? 0)
  return {
    employees: Number(row?.employees ?? 0),
    employeeShareMinor,
    employerShareMinor,
    dueMinor: employeeShareMinor + employerShareMinor,
  }
}

/** Figures are final, and so payable, only once the run is approved. */
const isPayable = (run: payrollRepository.PayrollRunRow): boolean => run.status === 'APPROVED' || run.status === 'LOCKED'

/** A challan can be recorded against an approved run with something due, paid no earlier than the period starts. */
async function assertCanRecord(run: payrollRepository.PayrollRunRow, scheme: Scheme, paidOn: IsoDate): Promise<void> {
  if (!isPayable(run)) {
    throw ApiError.payment(`${scheme} challans can only be recorded once the payroll run is approved`)
  }
  if ((await schemeDues(run.id, scheme)).dueMinor <= 0) {
    throw ApiError.businessRule(`Nothing is due for ${scheme} in ${monthLabel(run.year, run.month)}`)
  }
  if (paidOn < run.period_start) {
    throw ApiError.payment('The payment date cannot be before the payroll period starts')
  }
}

async function storeProof(
  organizationId: string,
  runId: string,
  scheme: Scheme,
  file: { buffer: Buffer; originalname: string },
): Promise<{ key: string; contentType: string; filename: string }> {
  const contentType = sniffContentType(file.buffer)
  if (!contentType || !PROOF_TYPES.has(contentType)) {
    throw ApiError.badRequest('The proof must be a PDF, PNG or JPEG file')
  }
  const key = `${organizationId}/statutory-proof/${runId}-${scheme.toLowerCase()}-${randomUUID()}.${extensionForType(contentType)}`
  await storage.put(key, file.buffer, contentType)
  return { key, contentType, filename: sanitiseFilename(file.originalname) }
}

async function deleteProofFile(key: string): Promise<void> {
  await storage.delete(key).catch((error: unknown) => {
    logger.warn({ error, key }, 'Could not delete a PF / ESI challan proof file')
  })
}

/** The same challan number twice for a run and scheme is refused by a unique index; say so plainly. */
function duplicateChallan(error: unknown, scheme: Scheme, input: ChallanInput): ApiError | null {
  const code = (error as { code?: string } | null)?.code
  return code === '23505' ? ApiError.conflict(`Challan ${input.challanNumber} is already recorded for ${scheme} this month`) : null
}

export const statutoryPaymentRouter = Router()
statutoryPaymentRouter.use(authenticate)

const canView = requirePermissions(PERMISSIONS.PAYMENT_VIEW_ALL)
const canManage = requirePermissions(PERMISSIONS.PAYMENT_MANAGE)

/** A run's PF and ESI: what is due, the challans that paid it, and whether that covers it. */
statutoryPaymentRouter.get(
  '/runs/:runId',
  canView,
  validate({ params: runParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const run = await findRunOrThrow(req.params.runId as string, auth.organizationId)

    const challans = await queryRows<ChallanRow>(
      pool,
      `${SELECT_CHALLAN} WHERE c.payroll_run_id = $1 AND c.organization_id = $2 ORDER BY c.paid_on, c.created_at`,
      [run.id, auth.organizationId],
    )

    const schemes = []
    for (const scheme of Object.keys(SCHEMES) as Scheme[]) {
      const dues = await schemeDues(run.id, scheme)
      const own = challans.filter((challan) => challan.scheme === scheme)
      const paidMinor = own.reduce((sum, challan) => sum + toMinor(challan.amount), 0)
      schemes.push({
        scheme,
        label: SCHEMES[scheme].label,
        employees: dues.employees,
        employeeShare: dues.employeeShareMinor / 100,
        employerShare: dues.employerShareMinor / 100,
        totalDue: dues.dueMinor / 100,
        totalPaid: paidMinor / 100,
        balance: Math.max(dues.dueMinor - paidMinor, 0) / 100,
        status: schemeStatus(dues.dueMinor, paidMinor, own.length),
        challans: own.map(presentChallan),
      })
    }

    return sendSuccess(res, {
      runId: run.id,
      monthLabel: monthLabel(run.year, run.month),
      isPayable: isPayable(run),
      schemes,
    })
  }),
)

/** Records one challan, with its proof, against a run's PF or ESI. */
statutoryPaymentRouter.post(
  '/runs/:runId/:scheme/challans',
  canManage,
  // multer runs first so the multipart body is parsed before validation.
  uploadPaymentProof,
  validate({ params: schemeParam, body: challanSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const scheme = req.params.scheme as Scheme
    const input = req.body as ChallanInput
    const run = await findRunOrThrow(req.params.runId as string, auth.organizationId)
    await assertCanRecord(run, scheme, input.paidOn)
    if (!req.file) throw ApiError.badRequest('Attach the challan or proof of payment (PDF, PNG or JPEG)')

    const proof = await storeProof(auth.organizationId, run.id, scheme, req.file)
    let inserted: { id: string } | null
    try {
      inserted = await queryOne<{ id: string }>(
        pool,
        `INSERT INTO payroll_statutory_challans
           (organization_id, payroll_run_id, scheme, amount, paid_on, challan_number, notes,
            proof_path, proof_filename, proof_mime_type, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          auth.organizationId,
          run.id,
          scheme,
          toNumericString(toMinor(input.amount)),
          input.paidOn,
          input.challanNumber,
          input.notes,
          proof.key,
          proof.filename,
          proof.contentType,
          auth.userId,
        ],
      )
    } catch (error) {
      // Do not leave an orphaned file behind if the challan could not be saved.
      await deleteProofFile(proof.key)
      throw duplicateChallan(error, scheme, input) ?? error
    }

    const saved = await findChallan(inserted!.id, auth.organizationId)
    await recordAudit({
      ...auditContextFrom(req),
      action: 'STATUTORY_CHALLAN_ADDED',
      entityType: 'payroll_run',
      entityId: run.id,
      newValues: { scheme, ...presentChallan(saved) },
    })
    return sendCreated(res, presentChallan(saved), `${scheme} challan ${input.challanNumber} recorded`)
  }),
)

/** Corrects a challan; a new file, when one is sent, replaces its proof. */
statutoryPaymentRouter.patch(
  '/challans/:challanId',
  canManage,
  uploadPaymentProof,
  validate({ params: challanParam, body: challanSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as ChallanInput
    const existing = await findChallan(req.params.challanId as string, auth.organizationId)
    const run = await findRunOrThrow(existing.payroll_run_id, auth.organizationId)
    await assertCanRecord(run, existing.scheme, input.paidOn)

    const uploaded = req.file ? await storeProof(auth.organizationId, run.id, existing.scheme, req.file) : null
    const proof = uploaded ?? {
      key: existing.proof_path,
      contentType: existing.proof_mime_type,
      filename: existing.proof_filename,
    }
    try {
      await pool.query(
        `UPDATE payroll_statutory_challans
            SET amount = $3, paid_on = $4, challan_number = $5, notes = $6,
                proof_path = $7, proof_filename = $8, proof_mime_type = $9
          WHERE id = $1 AND organization_id = $2`,
        [
          existing.id,
          auth.organizationId,
          toNumericString(toMinor(input.amount)),
          input.paidOn,
          input.challanNumber,
          input.notes,
          proof.key,
          proof.filename,
          proof.contentType,
        ],
      )
    } catch (error) {
      if (uploaded) await deleteProofFile(uploaded.key)
      throw duplicateChallan(error, existing.scheme, input) ?? error
    }
    if (uploaded) await deleteProofFile(existing.proof_path)

    const saved = await findChallan(existing.id, auth.organizationId)
    await recordAudit({
      ...auditContextFrom(req),
      action: 'STATUTORY_CHALLAN_UPDATED',
      entityType: 'payroll_run',
      entityId: run.id,
      oldValues: { scheme: existing.scheme, ...presentChallan(existing) },
      newValues: { scheme: existing.scheme, ...presentChallan(saved) },
    })
    return sendSuccess(res, presentChallan(saved), 'Challan updated')
  }),
)

/** Removes a challan recorded by mistake, and its proof. */
statutoryPaymentRouter.delete(
  '/challans/:challanId',
  canManage,
  validate({ params: challanParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findChallan(req.params.challanId as string, auth.organizationId)

    await pool.query('DELETE FROM payroll_statutory_challans WHERE id = $1', [existing.id])
    await deleteProofFile(existing.proof_path)

    await recordAudit({
      ...auditContextFrom(req),
      action: 'STATUTORY_CHALLAN_DELETED',
      entityType: 'payroll_run',
      entityId: existing.payroll_run_id,
      oldValues: { scheme: existing.scheme, ...presentChallan(existing) },
    })
    return sendSuccess(res, null, 'Challan removed')
  }),
)

/** Streams a challan's proof only after the permission check, always as an attachment. */
statutoryPaymentRouter.get(
  '/challans/:challanId/proof',
  canView,
  validate({ params: challanParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findChallan(req.params.challanId as string, auth.organizationId)

    const buffer = await storage.get(existing.proof_path)
    res.setHeader('Content-Type', existing.proof_mime_type)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${sanitiseFilename(existing.proof_filename)}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(buffer)
  }),
)
