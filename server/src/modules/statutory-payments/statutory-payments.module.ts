import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { uploadPaymentProof } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { monthLabel, type IsoDate } from '../../utils/dates.js'
import { toMinor, toNumericString } from '../../utils/money.js'
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
 * Every payroll run owes EPFO and ESIC one challan each: the employees' shares
 * deducted from pay plus the employer's contribution on top. This module shows
 * what each run owes, worked out from the run's own components, and records
 * that a challan was paid - the date, amount, challan number and the proof of
 * payment, which is required. Nothing here talks to a government system.
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

interface StatutoryPaymentRow {
  id: string
  payroll_run_id: string
  scheme: Scheme
  amount: string
  paid_on: IsoDate
  reference_number: string | null
  notes: string | null
  proof_path: string
  proof_filename: string
  proof_mime_type: string
  paid_by_name?: string | null
  updated_at: Date
}

const runParam = z.object({ runId: z.string().uuid() })
const schemeParam = runParam.extend({ scheme: z.enum(['PF', 'ESI']) })

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : null))

// Arrives as multipart form data, so every field is a string.
const markPaidSchema = z.object({
  amount: z.coerce.number().positive('The amount paid must be greater than zero').max(99_999_999),
  paidOn: isoDateSchema,
  referenceNumber: optionalText(120),
  notes: optionalText(300),
})

type MarkPaidInput = z.infer<typeof markPaidSchema>

function presentPayment(row: StatutoryPaymentRow) {
  return {
    amount: Number(row.amount),
    paidOn: row.paid_on,
    referenceNumber: row.reference_number,
    notes: row.notes,
    // The storage key is never sent; the file is fetched through the API.
    proofFilename: row.proof_filename,
    paidByName: row.paid_by_name ?? null,
    updatedAt: row.updated_at,
  }
}

async function findPayment(runId: string, scheme: Scheme, organizationId: string): Promise<StatutoryPaymentRow | null> {
  return queryOne<StatutoryPaymentRow>(
    pool,
    `SELECT sp.*, u.full_name AS paid_by_name
       FROM payroll_statutory_payments sp
       LEFT JOIN users u ON u.id = sp.paid_by
      WHERE sp.payroll_run_id = $1 AND sp.scheme = $2 AND sp.organization_id = $3`,
    [runId, scheme, organizationId],
  )
}

async function findRunOrThrow(runId: string, organizationId: string): Promise<payrollRepository.PayrollRunRow> {
  const run = await payrollRepository.findRun(runId, organizationId)
  if (!run) throw ApiError.notFound('Payroll run')
  return run
}

/** What a run owes each scheme, from its items' components. */
async function runDues(runId: string) {
  const dues = {} as Record<Scheme, { employees: number; employeeShare: number; employerShare: number; totalDue: number }>
  for (const scheme of Object.keys(SCHEMES) as Scheme[]) {
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
    dues[scheme] = {
      employees: Number(row?.employees ?? 0),
      employeeShare: employeeShareMinor / 100,
      employerShare: employerShareMinor / 100,
      totalDue: (employeeShareMinor + employerShareMinor) / 100,
    }
  }
  return dues
}

/** Figures are final, and so payable, only once the run is approved. */
const isPayable = (run: payrollRepository.PayrollRunRow): boolean => run.status === 'APPROVED' || run.status === 'LOCKED'

async function deleteProofFile(key: string): Promise<void> {
  await storage.delete(key).catch((error: unknown) => {
    logger.warn({ error, key }, 'Could not delete a PF / ESI payment proof file')
  })
}

export const statutoryPaymentRouter = Router()
statutoryPaymentRouter.use(authenticate)

const canView = requirePermissions(PERMISSIONS.PAYMENT_VIEW_ALL)
const canManage = requirePermissions(PERMISSIONS.PAYMENT_MANAGE)

/** A run's PF and ESI: what is due and whether it has been paid. */
statutoryPaymentRouter.get(
  '/runs/:runId',
  canView,
  validate({ params: runParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const run = await findRunOrThrow(req.params.runId as string, auth.organizationId)

    const [dues, payments] = await Promise.all([
      runDues(run.id),
      queryRows<StatutoryPaymentRow>(
        pool,
        `SELECT sp.*, u.full_name AS paid_by_name
           FROM payroll_statutory_payments sp
           LEFT JOIN users u ON u.id = sp.paid_by
          WHERE sp.payroll_run_id = $1 AND sp.organization_id = $2`,
        [run.id, auth.organizationId],
      ),
    ])

    return sendSuccess(res, {
      runId: run.id,
      monthLabel: monthLabel(run.year, run.month),
      isPayable: isPayable(run),
      schemes: (Object.keys(SCHEMES) as Scheme[]).map((scheme) => {
        const payment = payments.find((entry) => entry.scheme === scheme)
        return {
          scheme,
          label: SCHEMES[scheme].label,
          ...dues[scheme],
          status: payment ? 'PAID' : dues[scheme].totalDue > 0 ? 'PENDING' : 'NOT_DUE',
          payment: payment ? presentPayment(payment) : null,
        }
      }),
    })
  }),
)

/**
 * Marks a run's PF or ESI as paid, or corrects a payment already recorded.
 * The proof is required the first time; after that a new file replaces it.
 */
statutoryPaymentRouter.put(
  '/runs/:runId/:scheme',
  canManage,
  // multer runs first so the multipart body is parsed before validation.
  uploadPaymentProof,
  validate({ params: schemeParam, body: markPaidSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const scheme = req.params.scheme as Scheme
    const input = req.body as MarkPaidInput
    const run = await findRunOrThrow(req.params.runId as string, auth.organizationId)

    if (!isPayable(run)) {
      throw ApiError.payment(`${scheme} can only be marked paid once the payroll run is approved`)
    }
    if ((await runDues(run.id))[scheme].totalDue <= 0) {
      throw ApiError.businessRule(`Nothing is due for ${scheme} in ${monthLabel(run.year, run.month)}`)
    }
    if (input.paidOn < run.period_start) {
      throw ApiError.payment('The payment date cannot be before the payroll period starts')
    }

    const existing = await findPayment(run.id, scheme, auth.organizationId)
    if (!req.file && !existing) {
      throw ApiError.badRequest('Attach the proof of payment (PDF, PNG or JPEG)')
    }

    let uploaded: { key: string; contentType: string; filename: string } | null = null
    if (req.file) {
      const contentType = sniffContentType(req.file.buffer)
      if (!contentType || !PROOF_TYPES.has(contentType)) {
        throw ApiError.badRequest('The proof must be a PDF, PNG or JPEG file')
      }
      const key = `${auth.organizationId}/statutory-proof/${run.id}-${scheme.toLowerCase()}-${randomUUID()}.${extensionForType(contentType)}`
      await storage.put(key, req.file.buffer, contentType)
      uploaded = { key, contentType, filename: sanitiseFilename(req.file.originalname) }
    }

    const proof = uploaded ?? {
      key: existing!.proof_path,
      contentType: existing!.proof_mime_type,
      filename: existing!.proof_filename,
    }

    try {
      await pool.query(
        `INSERT INTO payroll_statutory_payments
           (organization_id, payroll_run_id, scheme, amount, paid_on, reference_number, notes,
            proof_path, proof_filename, proof_mime_type, paid_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (payroll_run_id, scheme) DO UPDATE
           SET amount = EXCLUDED.amount, paid_on = EXCLUDED.paid_on,
               reference_number = EXCLUDED.reference_number, notes = EXCLUDED.notes,
               proof_path = EXCLUDED.proof_path, proof_filename = EXCLUDED.proof_filename,
               proof_mime_type = EXCLUDED.proof_mime_type, paid_by = EXCLUDED.paid_by`,
        [
          auth.organizationId,
          run.id,
          scheme,
          toNumericString(toMinor(input.amount)),
          input.paidOn,
          input.referenceNumber,
          input.notes,
          proof.key,
          proof.filename,
          proof.contentType,
          auth.userId,
        ],
      )
    } catch (error) {
      // Do not leave an orphaned file behind if the record could not be saved.
      if (uploaded) await deleteProofFile(uploaded.key)
      throw error
    }

    if (uploaded && existing && existing.proof_path !== uploaded.key) await deleteProofFile(existing.proof_path)

    await recordAudit({
      ...auditContextFrom(req),
      action: 'STATUTORY_PAYMENT_MARKED_PAID',
      entityType: 'payroll_run',
      entityId: run.id,
      oldValues: existing ? { scheme, ...presentPayment(existing) } : null,
      newValues: {
        scheme,
        amount: input.amount,
        paidOn: input.paidOn,
        referenceNumber: input.referenceNumber,
        proof: proof.filename,
      },
    })

    const saved = await findPayment(run.id, scheme, auth.organizationId)
    return sendSuccess(res, saved ? presentPayment(saved) : null, `${scheme} marked as paid`)
  }),
)

/** Undoes a payment recorded by mistake: the run's PF or ESI is unpaid again and its proof is removed. */
statutoryPaymentRouter.delete(
  '/runs/:runId/:scheme',
  canManage,
  validate({ params: schemeParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const scheme = req.params.scheme as Scheme
    const run = await findRunOrThrow(req.params.runId as string, auth.organizationId)
    const existing = await findPayment(run.id, scheme, auth.organizationId)
    if (!existing) throw ApiError.notFound(`${scheme} payment`)

    await pool.query('DELETE FROM payroll_statutory_payments WHERE id = $1', [existing.id])
    await deleteProofFile(existing.proof_path)

    await recordAudit({
      ...auditContextFrom(req),
      action: 'STATUTORY_PAYMENT_MARKED_UNPAID',
      entityType: 'payroll_run',
      entityId: run.id,
      oldValues: { scheme, ...presentPayment(existing) },
    })

    return sendSuccess(res, null, `${scheme} marked as unpaid`)
  }),
)

/** Streams the proof only after the permission check, always as an attachment. */
statutoryPaymentRouter.get(
  '/runs/:runId/:scheme/proof',
  canView,
  validate({ params: schemeParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const existing = await findPayment(req.params.runId as string, req.params.scheme as Scheme, auth.organizationId)
    if (!existing) throw ApiError.notFound('Payment proof')

    const buffer = await storage.get(existing.proof_path)
    res.setHeader('Content-Type', existing.proof_mime_type)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${sanitiseFilename(existing.proof_filename)}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(buffer)
  }),
)
