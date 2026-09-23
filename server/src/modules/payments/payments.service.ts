import { z } from 'zod'
import { ApiError } from '../../utils/api-error.js'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction, type TxClient } from '../../database/tx.js'
import { toMinor, toNumericString, type Minor } from '../../utils/money.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope } from '../employees/employee-access.js'
import { notifyUserForEmployee } from '../notifications/notifications.service.js'
import { storage } from '../documents/storage.service.js'
import { sanitiseFilename, sniffContentType, extensionForType } from '../../utils/files.js'
import { randomUUID } from 'node:crypto'
import * as payrollRepository from '../payroll/payroll.repository.js'
import type { AuthContext } from '../../types/express.js'
import type { IsoDate } from '../../utils/dates.js'

/**
 * Salary payments (plan sections 29, 30 and 55).
 *
 * Payment state is tracked separately from payroll processing state, and every
 * payment is an immutable transaction row rather than an edit to a status field,
 * so partial payments add up to an auditable history.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const paymentCreateSchema = z.object({
  paymentDate: isoDateSchema,
  amount: z.coerce.number().positive('The payment amount must be greater than zero').max(99_999_999),
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI', 'OTHER']).default('BANK_TRANSFER'),
  referenceNumber: z.string().trim().max(80).nullish(),
  bankAccountId: z.string().uuid().nullish(),
  notes: z.string().trim().max(300).nullish(),
})

export const paymentReverseSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(300),
})

/**
 * A bulk payment may arrive as JSON, or as multipart form data when it carries a
 * reference document. Form fields are all strings, so the list of item ids comes
 * through as a JSON-encoded array and is decoded here.
 */
const idListFromForm = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const bulkPaymentSchema = z.object({
  payrollRunId: z.string().uuid(),
  paymentDate: isoDateSchema,
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI', 'OTHER']).default('BANK_TRANSFER'),
  /** Pay the full outstanding amount for these items. */
  payrollItemIds: z.preprocess(idListFromForm, z.array(z.string().uuid()).min(1).max(1000)),
  referencePrefix: z.string().trim().max(40).nullish(),
  notes: z.string().trim().max(300).nullish(),
})

export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>
export type PaymentReverseInput = z.infer<typeof paymentReverseSchema>
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string
  payroll_item_id: string
  payment_date: IsoDate
  amount: string
  payment_method: string
  reference_number: string | null
  notes: string | null
  reversed_at: Date | null
  reversal_reason: string | null
  proof_path: string | null
  proof_filename: string | null
  proof_mime_type: string | null
  proof_uploaded_at: Date | null
  created_at: Date
  created_by_name?: string | null
  employee_code?: string
  employee_name?: string
}

async function listPaymentsForItem(payrollItemId: string, db: Queryable = pool): Promise<PaymentRow[]> {
  return queryRows<PaymentRow>(
    db,
    `SELECT t.*, u.full_name AS created_by_name
       FROM payroll_payment_transactions t
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.payroll_item_id = $1
      ORDER BY t.payment_date ASC, t.created_at ASC`,
    [payrollItemId],
  )
}

function present(row: PaymentRow) {
  return {
    id: row.id,
    payrollItemId: row.payroll_item_id,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    referenceNumber: row.reference_number,
    notes: row.notes,
    isReversed: row.reversed_at !== null,
    reversedAt: row.reversed_at,
    reversalReason: row.reversal_reason,
    /* The storage key is never sent; the file is fetched through the API. */
    hasProof: row.proof_path !== null,
    proofFilename: row.proof_filename,
    proofUploadedAt: row.proof_uploaded_at,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    employeeCode: row.employee_code ?? null,
    employeeName: row.employee_name ?? null,
  }
}

/**
 * Sums the live (non-reversed) payments for an item and rewrites the item's
 * payment columns. The sum is derived from the transactions rather than
 * incremented, so a reversal can never leave the status inconsistent.
 */
async function recomputePaymentState(
  payrollItemId: string,
  db: Queryable,
): Promise<{ paidMinor: Minor; pendingMinor: Minor; status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' }> {
  const row = await queryOne<{ net_salary: string; paid: string }>(
    db,
    `SELECT i.net_salary,
            coalesce((
              SELECT sum(t.amount) FROM payroll_payment_transactions t
               WHERE t.payroll_item_id = i.id AND t.reversed_at IS NULL
            ), 0) AS paid
       FROM payroll_items i
      WHERE i.id = $1`,
    [payrollItemId],
  )
  if (!row) throw ApiError.notFound('Payroll item')

  const netMinor = toMinor(row.net_salary)
  const paidMinor = toMinor(row.paid)
  const pendingMinor = Math.max(netMinor - paidMinor, 0)

  // Plan section 55: PAID only when the full net has been paid. An item with
  // nothing payable (a zero or negative net) has nothing left to pay, so it is
  // settled rather than left pending for ever.
  const status = netMinor <= 0 ? 'PAID' : paidMinor <= 0 ? 'PENDING' : pendingMinor <= 0 ? 'PAID' : 'PARTIALLY_PAID'

  await db.query(
    'UPDATE payroll_items SET paid_amount = $2, pending_amount = $3, payment_status = $4 WHERE id = $1',
    [payrollItemId, toNumericString(paidMinor), toNumericString(pendingMinor), status],
  )

  return { paidMinor, pendingMinor, status }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

async function assertCanViewItem(auth: AuthContext, item: payrollRepository.PayrollItemRow): Promise<void> {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.PAYMENT_VIEW_ALL,
    self: PERMISSIONS.PAYMENT_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, item.employee_id, scope)
}

export async function listPayments(auth: AuthContext, payrollItemId: string) {
  const item = await payrollRepository.findItem(payrollItemId, auth.organizationId)
  if (!item) throw ApiError.notFound('Payroll item')
  await assertCanViewItem(auth, item)

  const payments = await listPaymentsForItem(payrollItemId)
  return {
    payrollItemId,
    employeeCode: item.employee_code,
    employeeName: item.employee_name,
    netSalary: Number(item.net_salary),
    paidAmount: Number(item.paid_amount),
    pendingAmount: Number(item.pending_amount),
    paymentStatus: item.payment_status,
    payments: payments.map(present),
  }
}

/**
 * Records one payment against a payroll item.
 *
 * The two rules that matter (plan section 55) are enforced here, inside a
 * transaction that holds a row lock on the item: the amount must be positive,
 * and the running total must never exceed the net salary.
 */
export async function recordPayment(
  auth: AuthContext,
  payrollItemId: string,
  input: PaymentCreateInput,
  context: AuditContext,
) {
  return withTransaction(async (tx) => {
    const item = await payrollRepository.findItemForUpdate(payrollItemId, auth.organizationId, tx)
    if (!item) throw ApiError.notFound('Payroll item')

    const run = await payrollRepository.findRun(item.payroll_run_id, auth.organizationId, tx)
    if (!run) throw ApiError.notFound('Payroll run')

    // Paying against an unapproved run would commit money to figures that can
    // still change.
    if (run.status !== 'APPROVED' && run.status !== 'LOCKED') {
      throw ApiError.payment('Payments can only be recorded against an approved or locked payroll run')
    }

    const netMinor = toMinor(item.net_salary)
    if (netMinor <= 0) {
      throw ApiError.payment('This payroll item has no payable amount')
    }

    // Recompute rather than trusting the stored column.
    const current = await recomputePaymentState(payrollItemId, tx)
    const remainingMinor = netMinor - current.paidMinor

    if (remainingMinor <= 0) {
      throw ApiError.payment('This salary has already been paid in full')
    }

    const amountMinor = toMinor(input.amount)
    if (amountMinor <= 0) {
      throw ApiError.payment('The payment amount must be greater than zero')
    }
    if (amountMinor > remainingMinor) {
      throw ApiError.payment(
        `The payment exceeds the remaining amount. Remaining: ${(remainingMinor / 100).toFixed(2)}, attempted: ${input.amount.toFixed(2)}.`,
      )
    }

    if (input.paymentDate < run.period_start) {
      throw ApiError.payment('The payment date cannot be before the payroll period starts')
    }

    const inserted = await queryOne<PaymentRow>(
      tx,
      `INSERT INTO payroll_payment_transactions
         (organization_id, payroll_item_id, payment_date, amount, payment_method, reference_number, bank_account_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        auth.organizationId,
        payrollItemId,
        input.paymentDate,
        toNumericString(amountMinor),
        input.paymentMethod,
        input.referenceNumber ?? null,
        input.bankAccountId ?? null,
        input.notes ?? null,
        auth.userId,
      ],
    )

    const updated = await recomputePaymentState(payrollItemId, tx)
    await payrollRepository.refreshRunTotals(item.payroll_run_id, tx)

    await recordAudit(
      {
        ...context,
        action: 'PAYMENT_ADDED',
        entityType: 'payroll_payment_transaction',
        entityId: inserted?.id ?? null,
        newValues: {
          payrollItemId,
          employeeCode: item.employee_code,
          amount: input.amount,
          method: input.paymentMethod,
          paymentStatus: updated.status,
        },
      },
      tx,
    )

    await notifyUserForEmployee(
      item.employee_id,
      {
        organizationId: auth.organizationId,
        type: 'PAYMENT_RECORDED',
        title: 'Salary payment recorded',
        body: `A payment of ${input.amount.toFixed(2)} has been recorded against your salary.`,
        link: '/my-salary',
      },
      tx,
    )

    return {
      payment: inserted ? present(inserted) : null,
      paidAmount: updated.paidMinor / 100,
      pendingAmount: updated.pendingMinor / 100,
      paymentStatus: updated.status,
    }
  })
}

/**
 * Reverses a payment.
 *
 * The transaction row is kept and flagged rather than deleted, so the history
 * still shows what happened (plan section 60).
 */
export async function reversePayment(
  auth: AuthContext,
  paymentId: string,
  input: PaymentReverseInput,
  context: AuditContext,
) {
  return withTransaction(async (tx) => {
    const payment = await queryOne<PaymentRow & { organization_id: string }>(
      tx,
      'SELECT * FROM payroll_payment_transactions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [paymentId, auth.organizationId],
    )
    if (!payment) throw ApiError.notFound('Payment')
    if (payment.reversed_at) throw ApiError.payment('This payment has already been reversed')

    await tx.query(
      'UPDATE payroll_payment_transactions SET reversed_at = now(), reversal_reason = $2, reversed_by = $3 WHERE id = $1',
      [paymentId, input.reason, auth.userId],
    )

    const updated = await recomputePaymentState(payment.payroll_item_id, tx)

    const item = await payrollRepository.findItem(payment.payroll_item_id, auth.organizationId, tx)
    if (item) await payrollRepository.refreshRunTotals(item.payroll_run_id, tx)

    await recordAudit(
      {
        ...context,
        action: 'PAYMENT_REVERSED',
        entityType: 'payroll_payment_transaction',
        entityId: paymentId,
        oldValues: { amount: Number(payment.amount) },
        newValues: { reason: input.reason, paymentStatus: updated.status },
      },
      tx,
    )

    return {
      paidAmount: updated.paidMinor / 100,
      pendingAmount: updated.pendingMinor / 100,
      paymentStatus: updated.status,
    }
  })
}

/**
 * Pays the full outstanding balance on many items at once.
 *
 * An optional reference document (receipt, bank advice) is stored once and
 * attached to every payment the call creates; it is dropped again if nothing
 * ended up being paid or the batch fails, so no orphan file is left behind.
 */
export async function recordBulkPayment(
  auth: AuthContext,
  input: BulkPaymentInput,
  context: AuditContext,
  file?: { buffer: Buffer; originalname: string },
) {
  let proof: { key: string; contentType: string; filename: string } | null = null
  if (file) {
    const contentType = sniffContentType(file.buffer)
    if (!contentType || !PROOF_TYPES.has(contentType)) {
      throw ApiError.badRequest('The reference document must be a PDF, PNG or JPEG file')
    }
    const key = `${auth.organizationId}/payment-proof/bulk-${randomUUID()}.${extensionForType(contentType)}`
    await storage.put(key, file.buffer, contentType)
    proof = { key, contentType, filename: sanitiseFilename(file.originalname) }
  }

  let result: Awaited<ReturnType<typeof recordBulkPaymentWithin>>
  try {
    result = await withTransaction((tx) => recordBulkPaymentWithin(tx, auth, input, context, proof))
  } catch (error) {
    if (proof) await storage.delete(proof.key).catch(() => undefined)
    throw error
  }
  if (proof && result.itemsPaid === 0) await storage.delete(proof.key).catch(() => undefined)
  return result
}

/** The body of recordBulkPayment, run on a caller-supplied transaction (also used by tests). */
export async function recordBulkPaymentWithin(
  tx: TxClient,
  auth: AuthContext,
  input: BulkPaymentInput,
  context: AuditContext,
  proof: { key: string; contentType: string; filename: string } | null,
) {
  const run = await payrollRepository.findRun(input.payrollRunId, auth.organizationId, tx)
  if (!run) throw ApiError.notFound('Payroll run')
  if (run.status !== 'APPROVED' && run.status !== 'LOCKED') {
    throw ApiError.payment('Payments can only be recorded against an approved or locked payroll run')
  }

  let paidCount = 0
  let totalMinor = 0
  const paymentIds: string[] = []
  const skipped: { payrollItemId: string; reason: string }[] = []

  for (const payrollItemId of input.payrollItemIds) {
    const item = await payrollRepository.findItemForUpdate(payrollItemId, auth.organizationId, tx)
    if (!item || item.payroll_run_id !== input.payrollRunId) {
      skipped.push({ payrollItemId, reason: 'Not part of this payroll run' })
      continue
    }

    const current = await recomputePaymentState(payrollItemId, tx)
    const remainingMinor = toMinor(item.net_salary) - current.paidMinor

    if (remainingMinor <= 0) {
      skipped.push({ payrollItemId, reason: 'Already paid in full' })
      continue
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO payroll_payment_transactions
         (organization_id, payroll_item_id, payment_date, amount, payment_method, reference_number, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        auth.organizationId,
        payrollItemId,
        input.paymentDate,
        toNumericString(remainingMinor),
        input.paymentMethod,
        input.referencePrefix ? `${input.referencePrefix}-${item.employee_code}` : null,
        input.notes ?? null,
        auth.userId,
      ],
    )
    paymentIds.push((inserted.rows[0] as { id: string }).id)

    await recomputePaymentState(payrollItemId, tx)
    totalMinor += remainingMinor
    paidCount += 1
  }

  await payrollRepository.refreshRunTotals(input.payrollRunId, tx)

  if (proof && paymentIds.length > 0) {
    await tx.query(
      `UPDATE payroll_payment_transactions
          SET proof_path = $2, proof_filename = $3, proof_mime_type = $4,
              proof_uploaded_at = now(), proof_uploaded_by = $5
        WHERE id = ANY($1::uuid[])`,
      [paymentIds, proof.key, proof.filename, proof.contentType, auth.userId],
    )
  }

  await recordAudit(
    {
      ...context,
      action: 'PAYMENT_ADDED',
      entityType: 'payroll_run',
      entityId: input.payrollRunId,
      newValues: {
        bulk: true,
        itemsPaid: paidCount,
        totalAmount: totalMinor / 100,
        skipped: skipped.length,
        referenceDocument: proof ? proof.filename : null,
      },
    },
    tx,
  )

  return { itemsPaid: paidCount, totalAmount: totalMinor / 100, skipped }
}

/** Payment status roll-up for a run, used by the payments screen and reports. */
export async function getRunPaymentSummary(auth: AuthContext, runId: string) {
  const run = await payrollRepository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')

  const rows = await queryRows<{ payment_status: string; count: string; net: string; paid: string; pending: string }>(
    pool,
    `SELECT payment_status::text AS payment_status,
            count(*)::text AS count,
            coalesce(sum(net_salary), 0)::text AS net,
            coalesce(sum(paid_amount), 0)::text AS paid,
            coalesce(sum(pending_amount), 0)::text AS pending
       FROM payroll_items
      WHERE payroll_run_id = $1 AND organization_id = $2
      GROUP BY payment_status`,
    [runId, auth.organizationId],
  )

  const empty = { count: 0, net: 0, paid: 0, pending: 0 }
  const summary: Record<string, typeof empty> = {
    PENDING: { ...empty },
    PARTIALLY_PAID: { ...empty },
    PAID: { ...empty },
  }

  for (const row of rows) {
    summary[row.payment_status] = {
      count: Number(row.count),
      net: Number(row.net),
      paid: Number(row.paid),
      pending: Number(row.pending),
    }
  }

  return {
    runId,
    year: run.year,
    month: run.month,
    totalNet: Number(run.total_net),
    totalPaid: Number(run.total_paid),
    totalPending: Number(run.total_pending),
    byStatus: summary,
  }
}

// ---------------------------------------------------------------------------
// Proof of payment
//
// Cash and offline transfers have no bank record to point at, so a payment may
// carry a scanned receipt. Handled exactly like an employee document: the real
// type is read from the bytes, the file never gets a public URL, and it is
// streamed back only after the permission check on this router.
// ---------------------------------------------------------------------------

const PROOF_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg'])

/**
 * Deletes a stored proof file once no payment points at it. A bulk payment
 * shares one file across all the payments it created, so removing or replacing
 * the proof on one of them must not delete the others' copy.
 */
async function deleteProofFileIfUnused(key: string): Promise<void> {
  const stillUsed = await queryOne<{ id: string }>(
    pool,
    'SELECT id FROM payroll_payment_transactions WHERE proof_path = $1 LIMIT 1',
    [key],
  )
  if (!stillUsed) await storage.delete(key).catch(() => undefined)
}

async function findPayment(paymentId: string, organizationId: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(
    pool,
    'SELECT * FROM payroll_payment_transactions WHERE id = $1 AND organization_id = $2',
    [paymentId, organizationId],
  )
}

export async function attachPaymentProof(
  auth: AuthContext,
  paymentId: string,
  file: { buffer: Buffer; originalname: string },
  context: AuditContext,
) {
  const existing = await findPayment(paymentId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Payment')
  if (existing.reversed_at) throw ApiError.businessRule('A reversed payment cannot take new proof')

  const contentType = sniffContentType(file.buffer)
  if (!contentType || !PROOF_TYPES.has(contentType)) {
    throw ApiError.badRequest('Proof must be a PDF, PNG or JPEG file')
  }

  const key = `${auth.organizationId}/payment-proof/${paymentId}-${randomUUID()}.${extensionForType(contentType)}`
  await storage.put(key, file.buffer, contentType)

  const row = await queryOne<PaymentRow>(
    pool,
    `UPDATE payroll_payment_transactions
        SET proof_path = $3, proof_filename = $4, proof_mime_type = $5,
            proof_uploaded_at = now(), proof_uploaded_by = $6
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [paymentId, auth.organizationId, key, sanitiseFilename(file.originalname), contentType, auth.userId],
  )

  // Best effort: a stale object is harmless, a failed request is not.
  if (existing.proof_path && existing.proof_path !== key) {
    await deleteProofFileIfUnused(existing.proof_path)
  }

  await recordAudit({
    ...context,
    action: 'PAYMENT_PROOF_UPLOADED',
    entityType: 'payroll_payment_transaction',
    entityId: paymentId,
    newValues: { mimeType: contentType, bytes: file.buffer.length },
  })

  return row ? present(row) : null
}

export async function readPaymentProof(
  auth: AuthContext,
  paymentId: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const existing = await findPayment(paymentId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Payment')
  if (!existing.proof_path) throw ApiError.notFound('Payment proof')

  return {
    buffer: await storage.get(existing.proof_path),
    mimeType: existing.proof_mime_type ?? 'application/octet-stream',
    filename: existing.proof_filename ?? 'payment-proof',
  }
}

export async function removePaymentProof(auth: AuthContext, paymentId: string, context: AuditContext) {
  const existing = await findPayment(paymentId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Payment')
  if (!existing.proof_path) throw ApiError.notFound('Payment proof')

  const row = await queryOne<PaymentRow>(
    pool,
    `UPDATE payroll_payment_transactions
        SET proof_path = NULL, proof_filename = NULL, proof_mime_type = NULL,
            proof_uploaded_at = NULL, proof_uploaded_by = NULL
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [paymentId, auth.organizationId],
  )

  await deleteProofFileIfUnused(existing.proof_path)

  await recordAudit({
    ...context,
    action: 'PAYMENT_PROOF_REMOVED',
    entityType: 'payroll_payment_transaction',
    entityId: paymentId,
  })

  return row ? present(row) : null
}
