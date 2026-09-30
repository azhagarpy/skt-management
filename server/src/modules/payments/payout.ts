import { randomUUID } from 'node:crypto'
import type { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { uploadPaymentProof } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { extensionForType, sanitiseFilename, sniffContentType } from '../../utils/files.js'
import { storage } from '../documents/storage.service.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { auditContextFrom, recordAudit, type AuditAction } from '../audit/audit.service.js'
import type { PermissionCode } from '../auth/permissions.js'

/**
 * Payments made outside salary.
 *
 * A bonus or a PL Wages credit is not paid through payroll: it is paid on its
 * own, then marked paid here with the date, how it was paid, a reference and an
 * optional supporting document (a bank statement, a signed cash voucher) - or
 * put back to not paid. Rows paid together can share one document, so a stored
 * file is deleted only once no row points at it any more.
 *
 * Both tables carry the same payment columns (migration 0039) and the same two
 * statuses at this end of their life: APPROVED (ready to pay) and PAID.
 */

export type PayoutTable = 'employee_bonuses' | 'pl_wages_credits'

/**
 * A multipart form sends every field as a string, so a list of ids comes
 * through as a JSON-encoded array and is decoded here.
 */
export const idListFromForm = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const payoutSchema = z.object({
  paidOn: isoDateSchema,
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI', 'OTHER']).default('BANK_TRANSFER'),
  referenceNumber: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(300).nullish(),
})

export const bulkPayoutSchema = payoutSchema.extend({
  ids: z.preprocess(idListFromForm, z.array(z.string().uuid()).min(1).max(2000)),
})

export type PayoutInput = z.infer<typeof payoutSchema>
export type BulkPayoutInput = z.infer<typeof bulkPayoutSchema>

/** The payment columns both tables share. */
export interface PayoutColumns {
  paid_on: string | null
  payment_method: string | null
  reference_number: string | null
  payment_notes: string | null
  proof_path: string | null
  proof_filename: string | null
}

export function presentPayout(row: PayoutColumns) {
  return {
    paidOn: row.paid_on,
    paymentMethod: row.payment_method,
    referenceNumber: row.reference_number,
    paymentNotes: row.payment_notes,
    /* The storage key is never sent; the file is fetched through the API. */
    hasProof: row.proof_path !== null,
    proofFilename: row.proof_filename,
  }
}

interface StoredProof {
  key: string
  contentType: string
  filename: string
}

type UploadedFile = { buffer: Buffer; originalname: string } | undefined

/** Checks the real type of an uploaded document from its bytes, then stores it. */
async function storeProof(organizationId: string, folder: string, file: NonNullable<UploadedFile>): Promise<StoredProof> {
  const contentType = sniffContentType(file.buffer)
  if (!contentType) throw ApiError.badRequest('The supporting document must be a PDF, PNG or JPEG file')
  const key = `${organizationId}/${folder}/${randomUUID()}.${extensionForType(contentType)}`
  await storage.put(key, file.buffer, contentType)
  return { key, contentType, filename: sanitiseFilename(file.originalname) }
}

async function deleteProofIfUnused(table: PayoutTable, key: string): Promise<void> {
  const stillUsed = await queryOne<{ id: string }>(pool, `SELECT id FROM ${table} WHERE proof_path = $1 LIMIT 1`, [key])
  if (!stillUsed) await storage.delete(key).catch(() => undefined)
}

/**
 * Marks the rows among `ids` that are in one of `fromStatuses` as paid, and
 * returns how many were. A new document replaces the one each row had; without
 * one, a row keeps its existing document.
 */
async function recordPayout(
  table: PayoutTable,
  folder: string,
  organizationId: string,
  userId: string,
  ids: string[],
  fromStatuses: string[],
  input: PayoutInput,
  file: UploadedFile,
): Promise<{ paid: number; proofFilename: string | null }> {
  const proof = file ? await storeProof(organizationId, folder, file) : null

  let rows: { id: string; old_proof: string | null }[]
  try {
    rows = await queryRows<{ id: string; old_proof: string | null }>(
      pool,
      `WITH target AS (
         SELECT id, proof_path FROM ${table}
          WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND status::text = ANY($3::text[])
       )
       UPDATE ${table} t
          SET status = 'PAID',
              paid_on = $4,
              payment_method = $5,
              reference_number = $6,
              payment_notes = $7,
              paid_by = $8,
              proof_path = coalesce($9::text, t.proof_path),
              proof_filename = CASE WHEN $9::text IS NULL THEN t.proof_filename ELSE $10 END,
              proof_mime_type = CASE WHEN $9::text IS NULL THEN t.proof_mime_type ELSE $11 END
         FROM target
        WHERE t.id = target.id
        RETURNING t.id, target.proof_path AS old_proof`,
      [
        ids,
        organizationId,
        fromStatuses,
        input.paidOn,
        input.paymentMethod,
        input.referenceNumber || null,
        input.notes || null,
        userId,
        proof?.key ?? null,
        proof?.filename ?? null,
        proof?.contentType ?? null,
      ],
    )
  } catch (error) {
    if (proof) await storage.delete(proof.key).catch(() => undefined)
    throw error
  }

  if (proof) {
    if (rows.length === 0) await storage.delete(proof.key).catch(() => undefined)
    const replaced = new Set(
      rows.map((row) => row.old_proof).filter((key): key is string => key !== null && key !== proof.key),
    )
    for (const key of replaced) await deleteProofIfUnused(table, key)
  }

  return { paid: rows.length, proofFilename: proof?.filename ?? null }
}

export interface PayoutRouteOptions {
  table: PayoutTable
  /** What one row is called in messages, e.g. "bonus". */
  noun: string
  plural: string
  /** Storage folder for supporting documents, under the organization's own. */
  folder: string
  view: PermissionCode
  manage: PermissionCode
  entityType: string
  paidAction: AuditAction
  unpaidAction: AuditAction
}

/**
 * Adds the payment routes to a module's router:
 *
 *   POST  /mark-paid          many approved rows at once, one shared document
 *   PATCH /:id/mark-paid      one row; on a paid row, corrects its details
 *   PATCH /:id/mark-unpaid    back to approved; the document is dropped
 *   GET   /:id/proof          the supporting document
 *
 * Each accepts a multipart form, so the document can travel with the details.
 */
export function mountPayoutRoutes(router: Router, options: PayoutRouteOptions): void {
  const { table, noun, plural } = options
  const idParam = z.object({ id: z.string().uuid() })
  const title = noun.charAt(0).toUpperCase() + noun.slice(1)

  const findStatus = (id: string, organizationId: string) =>
    queryOne<{ status: string }>(pool, `SELECT status::text AS status FROM ${table} WHERE id = $1 AND organization_id = $2`, [
      id,
      organizationId,
    ])

  router.post(
    '/mark-paid',
    requirePermissions(options.manage),
    // multer runs first so the multipart body is parsed before validation.
    uploadPaymentProof,
    validate({ body: bulkPayoutSchema }),
    asyncHandler(async (req, res) => {
      const auth = requireAuth(req)
      const input = req.body as BulkPayoutInput
      const ids = [...new Set(input.ids)]

      const result = await recordPayout(table, options.folder, auth.organizationId, auth.userId, ids, ['APPROVED'], input, req.file)
      if (result.paid === 0) {
        throw ApiError.businessRule(`None of the chosen ${plural} is approved and waiting to be paid`)
      }
      const skipped = ids.length - result.paid

      await recordAudit({
        ...auditContextFrom(req),
        action: options.paidAction,
        entityType: options.entityType,
        entityId: null,
        newValues: {
          bulk: true,
          paid: result.paid,
          skipped,
          paidOn: input.paidOn,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber ?? null,
          document: result.proofFilename,
        },
      })

      return sendSuccess(
        res,
        { paid: result.paid, skipped },
        `Marked ${result.paid} ${result.paid === 1 ? noun : plural} as paid${
          skipped > 0 ? ` (${skipped} skipped: not approved, or already paid)` : ''
        }`,
      )
    }),
  )

  router.patch(
    '/:id/mark-paid',
    requirePermissions(options.manage),
    uploadPaymentProof,
    validate({ params: idParam, body: payoutSchema }),
    asyncHandler(async (req, res) => {
      const auth = requireAuth(req)
      const id = req.params.id as string
      const input = req.body as PayoutInput

      const existing = await findStatus(id, auth.organizationId)
      if (!existing) throw ApiError.notFound(title)
      if (existing.status !== 'APPROVED' && existing.status !== 'PAID') {
        throw ApiError.businessRule(`Only an approved ${noun} can be marked paid`)
      }

      const result = await recordPayout(table, options.folder, auth.organizationId, auth.userId, [id], ['APPROVED', 'PAID'], input, req.file)

      await recordAudit({
        ...auditContextFrom(req),
        action: options.paidAction,
        entityType: options.entityType,
        entityId: id,
        oldValues: { status: existing.status },
        newValues: {
          paidOn: input.paidOn,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber ?? null,
          document: result.proofFilename,
        },
      })

      return sendSuccess(res, { paid: result.paid }, existing.status === 'PAID' ? 'Payment details updated' : 'Marked as paid')
    }),
  )

  router.patch(
    '/:id/mark-unpaid',
    requirePermissions(options.manage),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const auth = requireAuth(req)
      const id = req.params.id as string

      const existing = await findStatus(id, auth.organizationId)
      if (!existing) throw ApiError.notFound(title)
      if (existing.status !== 'PAID') throw ApiError.businessRule(`Only a paid ${noun} can be marked not paid`)

      const rows = await queryRows<{ old_proof: string | null }>(
        pool,
        `WITH target AS (
           SELECT id, proof_path FROM ${table} WHERE id = $1 AND organization_id = $2 AND status = 'PAID'
         )
         UPDATE ${table} t
            SET status = 'APPROVED', paid_on = NULL, payment_method = NULL, reference_number = NULL,
                payment_notes = NULL, paid_by = NULL, proof_path = NULL, proof_filename = NULL, proof_mime_type = NULL
           FROM target
          WHERE t.id = target.id
          RETURNING target.proof_path AS old_proof`,
        [id, auth.organizationId],
      )
      const oldProof = rows[0]?.old_proof ?? null
      if (oldProof) await deleteProofIfUnused(table, oldProof)

      await recordAudit({
        ...auditContextFrom(req),
        action: options.unpaidAction,
        entityType: options.entityType,
        entityId: id,
        oldValues: { status: 'PAID' },
        newValues: { status: 'APPROVED' },
      })

      return sendSuccess(res, null, 'Marked as not paid')
    }),
  )

  router.get(
    '/:id/proof',
    requirePermissions(options.view),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const auth = requireAuth(req)
      const row = await queryOne<{ proof_path: string | null; proof_mime_type: string | null; proof_filename: string | null }>(
        pool,
        `SELECT proof_path, proof_mime_type, proof_filename FROM ${table} WHERE id = $1 AND organization_id = $2`,
        [req.params.id, auth.organizationId],
      )
      if (!row) throw ApiError.notFound(title)
      if (!row.proof_path) throw ApiError.notFound('Supporting document')

      const buffer = await storage.get(row.proof_path)
      res.setHeader('Content-Type', row.proof_mime_type ?? 'application/octet-stream')
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Content-Disposition', `attachment; filename="${row.proof_filename ?? options.folder}"`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(buffer)
    }),
  )
}
