import { ApiError } from '../../utils/api-error.js'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { monthLabel, todayIso } from '../../utils/dates.js'
import { buildPdf, loadLetterhead, type Letterhead } from '../../utils/pdf.js'
import { sha256 } from '../../utils/files.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope } from '../employees/employee-access.js'
import { storage } from '../documents/storage.service.js'
import { notifyUserForEmployee } from '../notifications/notifications.service.js'
import { deliverDocument } from '../messaging/messaging.service.js'
import * as payrollRepository from '../payroll/payroll.repository.js'
import type { AuthContext } from '../../types/express.js'
import { drawPayslipPage, renderPayslipPdf, type PayslipPdfData } from './payslip-pdf.js'

/**
 * Payslip generation (plan sections 41 and 44).
 *
 * A payslip is rendered once from the frozen payroll snapshot and stored as a
 * file. It is never regenerated from current salary data, and like every other
 * document it is served only through a permission-checked endpoint, never a
 * public URL (plan section 39).
 */

interface PayslipRow {
  id: string
  payroll_item_id: string
  employee_id: string
  storage_key: string
  file_size_bytes: string
  generated_at: Date
}

async function findPayslip(
  payrollItemId: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<PayslipRow | null> {
  return queryOne<PayslipRow>(
    db,
    'SELECT * FROM payslips WHERE payroll_item_id = $1 AND organization_id = $2',
    [payrollItemId, organizationId],
  )
}

interface BankSnippet {
  bank_name: string
  account_number: string
  ifsc_code: string
}

/** A payroll item together with the dates of the run it belongs to. */
type ItemWithPeriod = payrollRepository.PayrollItemRow & { period_start: string; period_end: string }

const ITEM_WITH_PERIOD_SQL = `SELECT i.*, r.year AS run_year, r.month AS run_month, r.status AS run_status,
            r.period_start::text AS period_start, r.period_end::text AS period_end
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id`

interface PaymentSnippet {
  payment_date: string
  amount: string
  payment_method: string
  reference_number: string | null
}

/** Everything one payslip page needs beyond the frozen payroll figures. */
async function loadPayslipData(item: ItemWithPeriod, letterhead: Letterhead): Promise<PayslipPdfData> {
  const components = await payrollRepository.listItemComponents(item.id)
  const bank = await queryOne<BankSnippet>(
    pool,
    'SELECT bank_name, account_number, ifsc_code FROM employee_bank_accounts WHERE employee_id = $1 AND is_primary',
    [item.employee_id],
  )
  const pf = await queryOne<{ uan_number: string | null }>(
    pool,
    'SELECT uan_number FROM employee_pf_details WHERE employee_id = $1',
    [item.employee_id],
  )
  const esi = await queryOne<{ esi_number: string | null }>(
    pool,
    'SELECT esi_number FROM employee_esi_details WHERE employee_id = $1',
    [item.employee_id],
  )
  const employee = await queryOne<{ location_name: string | null; photo_path: string | null }>(
    pool,
    `SELECT l.name AS location_name, e.photo_path
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1`,
    [item.employee_id],
  )
  const payments = await queryRows<PaymentSnippet>(
    pool,
    `SELECT payment_date::text AS payment_date, amount::text AS amount, payment_method::text AS payment_method, reference_number
       FROM payroll_payment_transactions
      WHERE payroll_item_id = $1 AND reversed_at IS NULL
      ORDER BY payment_date ASC, created_at ASC`,
    [item.id],
  )

  let photo: Buffer | null = null
  if (employee?.photo_path) {
    // A missing or unreadable photo must never stop the payslip being produced.
    try {
      photo = await storage.get(employee.photo_path)
    } catch (error) {
      logger.warn({ err: error }, 'Could not load the employee photo for a payslip')
    }
  }

  return {
    letterhead,
    item,
    period: { start: item.period_start, end: item.period_end },
    components,
    bank,
    uan: pf?.uan_number ?? null,
    esiNumber: esi?.esi_number ?? null,
    locationName: employee?.location_name ?? null,
    photo,
    payments: payments.map((row) => ({
      date: row.payment_date,
      amount: row.amount,
      method: row.payment_method,
      reference: row.reference_number,
    })),
    generatedOn: todayIso(),
  }
}

export interface GenerateResult {
  generated: number
  skipped: number
}

/** Generates a payslip for every item in an approved or locked run. */
export async function generateForRun(
  auth: AuthContext,
  runId: string,
  context: AuditContext,
): Promise<GenerateResult> {
  const run = await payrollRepository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')
  if (run.status !== 'APPROVED' && run.status !== 'LOCKED') {
    throw ApiError.businessRule('Payslips can only be generated for an approved or locked payroll run')
  }

  const letterhead = await loadLetterhead(auth.organizationId)

  const items = await queryRows<ItemWithPeriod>(pool, `${ITEM_WITH_PERIOD_SQL} WHERE i.payroll_run_id = $1`, [runId])

  let generated = 0
  let skipped = 0

  for (const item of items) {
    const existing = await findPayslip(item.id, auth.organizationId)
    if (existing) {
      skipped += 1
      continue
    }

    const buffer = await renderPayslipPdf(await loadPayslipData(item, letterhead))
    const storageKey = `${auth.organizationId}/payslips/${run.year}-${String(run.month).padStart(2, '0')}/${item.employee_id}-${item.id}.pdf`

    await storage.put(storageKey, buffer, 'application/pdf')

    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO payslips (organization_id, payroll_item_id, employee_id, storage_key, file_size_bytes, checksum_sha256, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [auth.organizationId, item.id, item.employee_id, storageKey, buffer.length, sha256(buffer), auth.userId],
      )
    })

    await notifyUserForEmployee(item.employee_id, {
      organizationId: auth.organizationId,
      type: 'PAYSLIP_AVAILABLE',
      title: 'Payslip available',
      body: `Your payslip for ${monthLabel(run.year, run.month)} is ready to download.`,
      link: '/my-payslips',
    })

    generated += 1
  }

  await recordAudit({
    ...context,
    action: 'PAYSLIP_GENERATED',
    entityType: 'payroll_run',
    entityId: runId,
    newValues: { generated, skipped },
  })

  return { generated, skipped }
}

/** Lists the payslips an employee can see. */
export async function listPayslips(auth: AuthContext, employeeId: string) {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.PAYSLIP_VIEW_ALL,
    self: PERMISSIONS.PAYSLIP_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const rows = await queryRows<{
    id: string
    payroll_item_id: string
    generated_at: Date
    file_size_bytes: string
    year: number
    month: number
    net_salary: string
    payment_status: string
  }>(
    pool,
    `SELECT p.id, p.payroll_item_id, p.generated_at, p.file_size_bytes,
            r.year, r.month, i.net_salary, i.payment_status::text AS payment_status
       FROM payslips p
       JOIN payroll_items i ON i.id = p.payroll_item_id
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE p.employee_id = $1 AND p.organization_id = $2
      ORDER BY r.year DESC, r.month DESC`,
    [employeeId, auth.organizationId],
  )

  return rows.map((row) => ({
    id: row.id,
    payrollItemId: row.payroll_item_id,
    year: row.year,
    month: row.month,
    monthLabel: monthLabel(row.year, row.month),
    netSalary: Number(row.net_salary),
    paymentStatus: row.payment_status,
    fileSizeBytes: Number(row.file_size_bytes),
    generatedAt: row.generated_at,
    downloadPath: `/payslips/${row.id}/file`,
  }))
}

/** Streams a payslip after checking the caller may see it. */
export async function readPayslipFile(auth: AuthContext, payslipId: string, context: AuditContext) {
  const row = await queryOne<PayslipRow & { year: number; month: number }>(
    pool,
    `SELECT p.*, r.year, r.month
       FROM payslips p
       JOIN payroll_items i ON i.id = p.payroll_item_id
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE p.id = $1 AND p.organization_id = $2`,
    [payslipId, auth.organizationId],
  )
  if (!row) throw ApiError.notFound('Payslip')

  const scope = resolveScope(auth, {
    all: PERMISSIONS.PAYSLIP_VIEW_ALL,
    self: PERMISSIONS.PAYSLIP_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, row.employee_id, scope)

  const buffer = await storage.get(row.storage_key)

  await recordAudit({
    ...context,
    action: 'PAYSLIP_DOWNLOADED',
    entityType: 'payslip',
    entityId: payslipId,
    newValues: { employeeId: row.employee_id, period: `${row.year}-${row.month}` },
  })

  return {
    buffer,
    filename: `payslip-${row.year}-${String(row.month).padStart(2, '0')}.pdf`,
    mimeType: 'application/pdf',
  }
}

// ---------------------------------------------------------------------------
// Downloading payslips for a month range
// ---------------------------------------------------------------------------

const payslipScope = (auth: AuthContext) =>
  resolveScope(auth, { all: PERMISSIONS.PAYSLIP_VIEW_ALL, self: PERMISSIONS.PAYSLIP_VIEW_SELF })

/** Payslips can only go out for a run that has been approved. */
const RELEASED_RUN_SQL = "r.status IN ('APPROVED', 'LOCKED')"

/** The months an employee has a payslip for, newest first. */
export async function listPayslipMonths(auth: AuthContext, employeeId: string, db: Queryable = pool) {
  await assertEmployeeInScope(auth, employeeId, payslipScope(auth))

  const rows = await queryRows<{ year: number; month: number; net_salary: string }>(
    db,
    `SELECT r.year, r.month, i.net_salary
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE i.employee_id = $1 AND i.organization_id = $2 AND ${RELEASED_RUN_SQL}
      ORDER BY r.year DESC, r.month DESC`,
    [employeeId, auth.organizationId],
  )

  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    value: `${row.year}-${String(row.month).padStart(2, '0')}`,
    monthLabel: monthLabel(row.year, row.month),
    netSalary: Number(row.net_salary),
  }))
}

export interface MonthRange {
  from: string
  to: string
}

const MAX_RANGE_MONTHS = 24

function monthIndex(value: string): number {
  const [year, month] = value.split('-')
  return Number(year) * 12 + Number(month)
}

/**
 * One PDF holding an employee's payslips for a range of months, a page per
 * month in date order. Months without a released payslip are left out; if there
 * are none at all the request is refused rather than returning an empty file.
 */
export async function renderPayslipRange(
  auth: AuthContext,
  employeeId: string,
  range: MonthRange,
  context: AuditContext,
  db: Queryable = pool,
) {
  await assertEmployeeInScope(auth, employeeId, payslipScope(auth))

  const fromIndex = monthIndex(range.from)
  const toIndex = monthIndex(range.to)
  if (toIndex < fromIndex) throw ApiError.badRequest('The end month cannot be before the start month')
  if (toIndex - fromIndex + 1 > MAX_RANGE_MONTHS) {
    throw ApiError.badRequest(`Choose a range of ${MAX_RANGE_MONTHS} months or fewer`)
  }

  const items = await queryRows<ItemWithPeriod>(
    db,
    `${ITEM_WITH_PERIOD_SQL}
      WHERE i.employee_id = $1 AND i.organization_id = $2 AND ${RELEASED_RUN_SQL}
        AND r.year * 12 + r.month BETWEEN $3 AND $4
      ORDER BY r.year, r.month`,
    [employeeId, auth.organizationId, fromIndex, toIndex],
  )
  if (items.length === 0) {
    throw ApiError.businessRule('This employee has no approved payslip in the chosen months')
  }

  const letterhead = await loadLetterhead(auth.organizationId)
  const pages: PayslipPdfData[] = []
  for (const item of items) pages.push(await loadPayslipData(item, letterhead))

  const first = items[0] as ItemWithPeriod
  const last = items[items.length - 1] as ItemWithPeriod
  const label = (item: ItemWithPeriod): string => `${item.run_year}-${String(item.run_month).padStart(2, '0')}`

  const buffer = await buildPdf(`Payslips ${first.employee_code}`, (doc) => {
    pages.forEach((page, index) => {
      if (index > 0) doc.addPage()
      drawPayslipPage(doc, page)
    })
  })

  await recordAudit({
    ...context,
    action: 'PAYSLIP_DOWNLOADED',
    entityType: 'employee',
    entityId: employeeId,
    newValues: { months: items.map(label), pages: items.length },
  })

  return {
    buffer,
    months: items.length,
    filename:
      items.length === 1
        ? `payslip-${first.employee_code}-${label(first)}.pdf`
        : `payslips-${first.employee_code}-${label(first)}_to_${label(last)}.pdf`,
    mimeType: 'application/pdf',
  }
}

export interface BulkDownloadInput {
  payrollRunId: string
  /** Omit (or leave empty) to download every payslip in the run. */
  employeeIds?: string[]
}

const MAX_BULK_EMPLOYEES = 300

/**
 * One PDF holding several employees' payslips for the same payroll run, a page
 * per employee, for admins downloading a batch to print or file at once.
 * Unlike `renderPayslipRange` this is never self-service: it always requires
 * PAYSLIP_VIEW_ALL (see payslips.routes.ts), so it does not check employee scope.
 */
export async function renderPayslipsForRun(
  auth: AuthContext,
  input: BulkDownloadInput,
  context: AuditContext,
  db: Queryable = pool,
) {
  const run = await queryOne<{ id: string; year: number; month: number; status: string }>(
    db,
    `SELECT id, year, month, status::text AS status FROM payroll_runs WHERE id = $1 AND organization_id = $2`,
    [input.payrollRunId, auth.organizationId],
  )
  if (!run) throw ApiError.notFound('Payroll run')
  if (run.status !== 'APPROVED' && run.status !== 'LOCKED') {
    throw ApiError.businessRule('Payslips can only be downloaded for an approved or locked payroll run')
  }

  const employeeIds = input.employeeIds?.filter(Boolean) ?? []
  if (employeeIds.length > MAX_BULK_EMPLOYEES) {
    throw ApiError.badRequest(`Choose ${MAX_BULK_EMPLOYEES} employees or fewer`)
  }

  const params: unknown[] = [input.payrollRunId, auth.organizationId]
  let employeeFilter = ''
  if (employeeIds.length > 0) {
    params.push(employeeIds)
    employeeFilter = `AND i.employee_id = ANY($${params.length}::uuid[])`
  }

  const items = await queryRows<ItemWithPeriod>(
    db,
    `${ITEM_WITH_PERIOD_SQL}
      WHERE i.payroll_run_id = $1 AND i.organization_id = $2 ${employeeFilter}
      ORDER BY i.employee_code`,
    params,
  )
  if (items.length === 0) throw ApiError.businessRule('No payslips match this selection')
  if (items.length > MAX_BULK_EMPLOYEES) {
    throw ApiError.badRequest(`Choose ${MAX_BULK_EMPLOYEES} employees or fewer`)
  }

  const letterhead = await loadLetterhead(auth.organizationId)
  const pages: PayslipPdfData[] = []
  for (const item of items) pages.push(await loadPayslipData(item, letterhead))

  const buffer = await buildPdf(`Payslips ${monthLabel(run.year, run.month)}`, (doc) => {
    pages.forEach((page, index) => {
      if (index > 0) doc.addPage()
      drawPayslipPage(doc, page)
    })
  })

  await recordAudit({
    ...context,
    action: 'PAYSLIP_DOWNLOADED',
    entityType: 'payroll_run',
    entityId: input.payrollRunId,
    newValues: { employees: items.length, period: `${run.year}-${run.month}` },
  })

  return {
    buffer,
    employees: items.length,
    filename: `payslips-${run.year}-${String(run.month).padStart(2, '0')}.pdf`,
    mimeType: 'application/pdf',
  }
}

export interface SendWhatsAppInput {
  payrollRunId: string
  /** Omit (or leave empty) to send every payslip in the run. */
  employeeIds?: string[]
}

export interface WhatsAppSendOutcome {
  employeeId: string
  employeeCode: string
  employeeName: string
  status: 'SENT' | 'SKIPPED' | 'FAILED'
  detail: string | null
}

const MAX_WHATSAPP_BATCH = 100

/**
 * Sends the payslip PDF to each employee's WhatsApp as a document, through the
 * approved WHATSAPP_PAYSLIP_TEMPLATE_NAME template (see whatsapp.service.ts -
 * there is no way to send a file outside the 24-hour session window without
 * one). Always an admin/supervisor action, never automatic, so it does not go
 * through the notifyUser/scenario path other WhatsApp messages use.
 */
export async function sendPayslipsViaWhatsApp(
  auth: AuthContext,
  input: SendWhatsAppInput,
  context: AuditContext,
  db: Queryable = pool,
): Promise<{ sent: number; skipped: number; failed: number; results: WhatsAppSendOutcome[] }> {
  const run = await queryOne<{ id: string; year: number; month: number; status: string }>(
    db,
    `SELECT id, year, month, status::text AS status FROM payroll_runs WHERE id = $1 AND organization_id = $2`,
    [input.payrollRunId, auth.organizationId],
  )
  if (!run) throw ApiError.notFound('Payroll run')
  if (run.status !== 'APPROVED' && run.status !== 'LOCKED') {
    throw ApiError.businessRule('Payslips can only be sent for an approved or locked payroll run')
  }

  const employeeIds = input.employeeIds?.filter(Boolean) ?? []
  if (employeeIds.length > MAX_WHATSAPP_BATCH) {
    throw ApiError.badRequest(`Choose ${MAX_WHATSAPP_BATCH} employees or fewer`)
  }

  const params: unknown[] = [input.payrollRunId, auth.organizationId]
  let employeeFilter = ''
  if (employeeIds.length > 0) {
    params.push(employeeIds)
    employeeFilter = `AND i.employee_id = ANY($${params.length}::uuid[])`
  }

  const items = await queryRows<ItemWithPeriod & { mobile_number: string | null }>(
    db,
    `SELECT i.*, r.year AS run_year, r.month AS run_month, r.status AS run_status,
            r.period_start::text AS period_start, r.period_end::text AS period_end,
            emp.mobile_number
       FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.payroll_run_id
       LEFT JOIN employees emp ON emp.id = i.employee_id
      WHERE i.payroll_run_id = $1 AND i.organization_id = $2 ${employeeFilter}
      ORDER BY i.employee_code`,
    params,
  )
  if (items.length === 0) throw ApiError.businessRule('No payslips match this selection')
  if (items.length > MAX_WHATSAPP_BATCH) {
    throw ApiError.badRequest(`Choose ${MAX_WHATSAPP_BATCH} employees or fewer`)
  }

  const letterhead = await loadLetterhead(auth.organizationId)
  const monthText = monthLabel(run.year, run.month)
  const results: WhatsAppSendOutcome[] = []

  for (const item of items) {
    const buffer = await renderPayslipPdf(await loadPayslipData(item, letterhead))
    const filename = `payslip-${item.employee_code}-${run.year}-${String(run.month).padStart(2, '0')}.pdf`

    const outcome = await deliverDocument({
      organizationId: auth.organizationId,
      employeeId: item.employee_id,
      recipientPhone: item.mobile_number,
      templateName: env.WHATSAPP_PAYSLIP_TEMPLATE_NAME,
      templateLanguage: env.WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE,
      variables: [item.employee_name, monthText],
      documentBuffer: buffer,
      documentMimeType: 'application/pdf',
      filename,
      preview: `Payslip for ${monthText}`,
    })

    results.push({
      employeeId: item.employee_id,
      employeeCode: item.employee_code,
      employeeName: item.employee_name,
      status: outcome.status,
      detail: outcome.reason,
    })
  }

  const sent = results.filter((entry) => entry.status === 'SENT').length
  const skipped = results.filter((entry) => entry.status === 'SKIPPED').length
  const failed = results.filter((entry) => entry.status === 'FAILED').length

  await recordAudit({
    ...context,
    action: 'PAYSLIP_SENT_WHATSAPP',
    entityType: 'payroll_run',
    entityId: input.payrollRunId,
    newValues: { period: `${run.year}-${run.month}`, sent, skipped, failed },
  })

  return { sent, skipped, failed, results }
}
