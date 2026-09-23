import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { pool, type Queryable } from '../../database/pool.js'
import { maskAadhaar, maskAccountNumber, maskPan } from '../../utils/mask.js'
import { buildStorageKey, sanitiseFilename, sha256, sniffContentType } from '../../utils/files.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope } from '../employees/employee-access.js'
import { notifyUserForEmployee } from '../notifications/notifications.service.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './documents.repository.js'
import { storage } from './storage.service.js'
import type {
  AadhaarInput,
  BankAccountInput,
  DocumentListQuery,
  EsiInput,
  PanInput,
  PfInput,
  UploadDocumentInput,
  VerifyDocumentInput,
  VerifySectionInput,
} from './documents.validation.js'

/**
 * Which scope the caller has over an employee's documents. Read and write are
 * resolved separately: a supervisor may *see* a team member's document status
 * without being able to upload on their behalf.
 */
function readScope(auth: AuthContext) {
  return resolveScope(auth, {
    all: PERMISSIONS.DOCUMENT_VIEW_ALL,
    team: PERMISSIONS.DOCUMENT_VIEW_TEAM,
    self: PERMISSIONS.DOCUMENT_VIEW_SELF,
  })
}

function writeScope(auth: AuthContext) {
  return resolveScope(auth, {
    all: PERMISSIONS.DOCUMENT_UPLOAD_ANY,
    self: PERMISSIONS.DOCUMENT_UPLOAD_SELF,
  })
}

export async function assertCanRead(auth: AuthContext, employeeId: string, db: Queryable = pool): Promise<void> {
  await assertEmployeeInScope(auth, employeeId, readScope(auth), db)
}

export async function assertCanWrite(auth: AuthContext, employeeId: string, db: Queryable = pool): Promise<void> {
  await assertEmployeeInScope(auth, employeeId, writeScope(auth), db)
}

/** True when the caller may see unmasked identity and account numbers. */
function canSeeSensitive(auth: AuthContext, employeeId: string): boolean {
  if (auth.has(PERMISSIONS.SENSITIVE_DATA_VIEW)) return true
  // An employee may always read back their own numbers.
  return auth.employeeId === employeeId
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export function presentDocument(row: repository.DocumentRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    category: row.category,
    title: row.title,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    // Deliberately no URL: the file is fetched through the protected endpoint
    // /employees/:id/documents/:documentId/file.
    downloadPath: `/employees/${row.employee_id}/documents/${row.id}/file`,
  }
}

function presentPan(row: repository.PanRow | null, reveal: boolean) {
  if (!row) return null
  return {
    id: row.id,
    panNumber: reveal ? row.pan_number : maskPan(row.pan_number),
    panMasked: maskPan(row.pan_number),
    panName: row.pan_name,
    documentId: row.document_id,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
  }
}

function presentAadhaar(row: repository.AadhaarRow | null, reveal: boolean) {
  if (!row) return null
  return {
    id: row.id,
    // Plan section 14: the full number is never returned to an unprivileged caller.
    aadhaarNumber: reveal ? row.aadhaar_number : null,
    aadhaarMasked: maskAadhaar(row.aadhaar_number),
    aadhaarLast4: row.aadhaar_last4,
    aadhaarName: row.aadhaar_name,
    documentId: row.document_id,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
  }
}

function presentBank(row: repository.BankAccountRow | null, reveal: boolean) {
  if (!row) return null
  return {
    id: row.id,
    accountHolderName: row.account_holder_name,
    bankName: row.bank_name,
    accountNumber: reveal ? row.account_number : null,
    accountMasked: maskAccountNumber(row.account_number),
    accountLast4: row.account_last4,
    ifscCode: row.ifsc_code,
    branchName: row.branch_name,
    accountType: row.account_type,
    isPrimary: row.is_primary,
    documentId: row.document_id,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
  }
}

function presentPf(row: repository.PfRow | null) {
  if (!row) return null
  return {
    id: row.id,
    pfApplicable: row.pf_applicable,
    uanNumber: row.uan_number,
    pfMemberId: row.pf_member_id,
    pfName: row.pf_name,
    pensionApplicable: row.pension_applicable,
    employeeContributionPercent: row.employee_contribution_percent === null ? null : Number(row.employee_contribution_percent),
    employerContributionPercent: row.employer_contribution_percent === null ? null : Number(row.employer_contribution_percent),
    documentId: row.document_id,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
  }
}

function presentEsi(row: repository.EsiRow | null) {
  if (!row) return null
  return {
    id: row.id,
    esiApplicable: row.esi_applicable,
    esiNumber: row.esi_number,
    esiName: row.esi_name,
    employeeContributionPercent: row.employee_contribution_percent === null ? null : Number(row.employee_contribution_percent),
    employerContributionPercent: row.employer_contribution_percent === null ? null : Number(row.employer_contribution_percent),
    documentId: row.document_id,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Document files
// ---------------------------------------------------------------------------

export async function listDocuments(auth: AuthContext, employeeId: string, filters: DocumentListQuery) {
  await assertCanRead(auth, employeeId)
  const rows = await repository.listDocuments(employeeId, filters)
  return rows.map(presentDocument)
}

export async function uploadDocument(
  auth: AuthContext,
  employeeId: string,
  file: { buffer: Buffer; originalname: string; size: number },
  input: UploadDocumentInput,
  context: AuditContext,
) {
  await assertCanWrite(auth, employeeId)

  if (file.buffer.length === 0) throw ApiError.upload('The uploaded file is empty')

  // The client-declared MIME type is ignored; the real type is sniffed here
  // (plan section 52: "Do not trust the MIME type supplied by the client").
  const contentType = sniffContentType(file.buffer)
  if (!contentType) {
    throw ApiError.upload('Only PDF, JPG and PNG files are accepted')
  }

  const storageKey = buildStorageKey({
    organizationId: auth.organizationId,
    employeeId,
    category: input.category,
    contentType,
  })

  await storage.put(storageKey, file.buffer, contentType)

  try {
    const row = await repository.insertDocument({
      organization_id: auth.organizationId,
      employee_id: employeeId,
      category: input.category,
      title: input.title,
      storage_key: storageKey,
      original_filename: sanitiseFilename(file.originalname),
      mime_type: contentType,
      file_size_bytes: file.buffer.length,
      checksum_sha256: sha256(file.buffer),
      uploaded_by: auth.userId,
    })

    await recordAudit({
      ...context,
      action: 'DOCUMENT_UPLOADED',
      entityType: 'employee_document',
      entityId: row.id,
      newValues: { employeeId, category: input.category, title: input.title, sizeBytes: file.buffer.length },
    })

    return presentDocument(row)
  } catch (error) {
    // Do not leave an orphaned object behind if the metadata insert fails.
    await storage.delete(storageKey).catch(() => undefined)
    throw error
  }
}

export async function readDocumentFile(auth: AuthContext, employeeId: string, documentId: string, context: AuditContext) {
  await assertCanRead(auth, employeeId)

  const row = await repository.findDocument(documentId, auth.organizationId)
  if (!row || row.employee_id !== employeeId) throw ApiError.notFound('Document')

  const buffer = await storage.get(row.storage_key)

  await recordAudit({
    ...context,
    action: 'DOCUMENT_DOWNLOADED',
    entityType: 'employee_document',
    entityId: row.id,
    newValues: { employeeId, category: row.category },
  })

  return { buffer, filename: row.original_filename, mimeType: row.mime_type }
}

export async function verifyDocument(
  auth: AuthContext,
  employeeId: string,
  documentId: string,
  input: VerifyDocumentInput,
  context: AuditContext,
) {
  const existing = await repository.findDocument(documentId, auth.organizationId)
  if (!existing || existing.employee_id !== employeeId) throw ApiError.notFound('Document')

  const updated = await repository.setDocumentVerification(
    documentId,
    auth.organizationId,
    input.status,
    auth.userId,
    input.reason ?? null,
  )
  if (!updated) throw ApiError.notFound('Document')

  await recordAudit({
    ...context,
    action: input.status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
    entityType: 'employee_document',
    entityId: documentId,
    oldValues: { verificationStatus: existing.verification_status },
    newValues: { verificationStatus: input.status, reason: input.reason ?? null },
  })

  await notifyUserForEmployee(employeeId, {
    organizationId: auth.organizationId,
    type: input.status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
    title: input.status === 'VERIFIED' ? 'Document verified' : 'Document rejected',
    body:
      input.status === 'VERIFIED'
        ? `Your document "${existing.title}" has been verified.`
        : `Your document "${existing.title}" was rejected: ${input.reason ?? 'no reason given'}`,
    link: '/my-documents',
  })

  return presentDocument(updated)
}

export async function deleteDocument(
  auth: AuthContext,
  employeeId: string,
  documentId: string,
  context: AuditContext,
) {
  const existing = await repository.findDocument(documentId, auth.organizationId)
  if (!existing || existing.employee_id !== employeeId) throw ApiError.notFound('Document')

  await repository.deleteDocument(documentId, auth.organizationId)
  // Best effort: the metadata is the record of truth, a stranded object is harmless.
  await storage.delete(existing.storage_key).catch(() => undefined)

  await recordAudit({
    ...context,
    action: 'DOCUMENT_DELETED',
    entityType: 'employee_document',
    entityId: documentId,
    oldValues: { employeeId, category: existing.category, title: existing.title },
  })
}

// ---------------------------------------------------------------------------
// Identity and financial sections
// ---------------------------------------------------------------------------

export async function getIdentityProfile(auth: AuthContext, employeeId: string) {
  await assertCanRead(auth, employeeId)
  const reveal = canSeeSensitive(auth, employeeId)

  const [pan, aadhaar, bank, pf, esi, documents] = await Promise.all([
    repository.findPan(employeeId),
    repository.findAadhaar(employeeId),
    repository.findPrimaryBankAccount(employeeId),
    repository.findPf(employeeId),
    repository.findEsi(employeeId),
    repository.listDocuments(employeeId, {}),
  ])

  return {
    pan: presentPan(pan, reveal),
    aadhaar: presentAadhaar(aadhaar, reveal),
    bankAccount: presentBank(bank, reveal),
    pf: presentPf(pf),
    esi: presentEsi(esi),
    documents: documents.map(presentDocument),
    sensitiveVisible: reveal,
  }
}

export async function savePan(auth: AuthContext, employeeId: string, input: PanInput, context: AuditContext) {
  await assertCanWrite(auth, employeeId)
  const row = await repository.upsertPan({
    organization_id: auth.organizationId,
    employee_id: employeeId,
    pan_number: input.panNumber,
    pan_name: input.panName,
    document_id: input.documentId ?? null,
  })

  await recordAudit({
    ...context,
    action: 'PAN_UPDATED',
    entityType: 'employee_pan_details',
    entityId: row.id,
    newValues: { employeeId, panMasked: maskPan(input.panNumber) },
  })

  return presentPan(row, canSeeSensitive(auth, employeeId))
}

export async function saveAadhaar(auth: AuthContext, employeeId: string, input: AadhaarInput, context: AuditContext) {
  await assertCanWrite(auth, employeeId)
  const row = await repository.upsertAadhaar({
    organization_id: auth.organizationId,
    employee_id: employeeId,
    aadhaar_number: input.aadhaarNumber,
    aadhaar_last4: input.aadhaarNumber.slice(-4),
    aadhaar_name: input.aadhaarName,
    document_id: input.documentId ?? null,
  })

  await recordAudit({
    ...context,
    action: 'AADHAAR_UPDATED',
    entityType: 'employee_aadhaar_details',
    entityId: row.id,
    newValues: { employeeId, aadhaarMasked: maskAadhaar(input.aadhaarNumber) },
  })

  return presentAadhaar(row, canSeeSensitive(auth, employeeId))
}

export async function saveBankAccount(
  auth: AuthContext,
  employeeId: string,
  input: BankAccountInput,
  context: AuditContext,
) {
  await assertCanWrite(auth, employeeId)

  const row = await withTransaction(async (tx) => {
    if (input.isPrimary) await repository.clearPrimaryBankAccount(employeeId, tx)
    return repository.insertBankAccount(
      {
        organization_id: auth.organizationId,
        employee_id: employeeId,
        account_holder_name: input.accountHolderName,
        bank_name: input.bankName,
        account_number: input.accountNumber,
        account_last4: input.accountNumber.slice(-4),
        ifsc_code: input.ifscCode,
        branch_name: input.branchName ?? null,
        account_type: input.accountType,
        is_primary: input.isPrimary,
        document_id: input.documentId ?? null,
      },
      tx,
    )
  })

  await recordAudit({
    ...context,
    action: 'BANK_ACCOUNT_UPDATED',
    entityType: 'employee_bank_accounts',
    entityId: row.id,
    newValues: {
      employeeId,
      bankName: input.bankName,
      accountMasked: maskAccountNumber(input.accountNumber),
      ifscCode: input.ifscCode,
    },
  })

  return presentBank(row, canSeeSensitive(auth, employeeId))
}

export async function savePf(auth: AuthContext, employeeId: string, input: PfInput, context: AuditContext) {
  await assertCanWrite(auth, employeeId)
  const row = await repository.upsertPf({
    organization_id: auth.organizationId,
    employee_id: employeeId,
    pf_applicable: input.pfApplicable,
    uan_number: input.uanNumber ?? null,
    pf_member_id: input.pfMemberId ?? null,
    pf_name: input.pfName ?? null,
    pension_applicable: input.pensionApplicable,
    employee_contribution_percent: input.employeeContributionPercent ?? null,
    employer_contribution_percent: input.employerContributionPercent ?? null,
    document_id: input.documentId ?? null,
  })

  await recordAudit({
    ...context,
    action: 'PF_UPDATED',
    entityType: 'employee_pf_details',
    entityId: row.id,
    newValues: { employeeId, pfApplicable: input.pfApplicable },
  })

  return presentPf(row)
}

export async function saveEsi(auth: AuthContext, employeeId: string, input: EsiInput, context: AuditContext) {
  await assertCanWrite(auth, employeeId)
  const row = await repository.upsertEsi({
    organization_id: auth.organizationId,
    employee_id: employeeId,
    esi_applicable: input.esiApplicable,
    esi_number: input.esiNumber ?? null,
    esi_name: input.esiName ?? null,
    employee_contribution_percent: input.employeeContributionPercent ?? null,
    employer_contribution_percent: input.employerContributionPercent ?? null,
    document_id: input.documentId ?? null,
  })

  await recordAudit({
    ...context,
    action: 'ESI_UPDATED',
    entityType: 'employee_esi_details',
    entityId: row.id,
    newValues: { employeeId, esiApplicable: input.esiApplicable },
  })

  return presentEsi(row)
}

export async function verifySection(
  auth: AuthContext,
  employeeId: string,
  input: VerifySectionInput,
  context: AuditContext,
) {
  await assertEmployeeInScope(auth, employeeId, 'ALL')

  const updated = await repository.setSectionVerification(
    input.section,
    employeeId,
    auth.organizationId,
    input.status,
    auth.userId,
    input.reason ?? null,
  )
  if (!updated) throw ApiError.notFound(`${input.section} details`)

  await recordAudit({
    ...context,
    action: input.status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
    entityType: `employee_${input.section.toLowerCase()}`,
    entityId: employeeId,
    newValues: { section: input.section, status: input.status, reason: input.reason ?? null },
  })

  await notifyUserForEmployee(employeeId, {
    organizationId: auth.organizationId,
    type: input.status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
    title: `${input.section} ${input.status === 'VERIFIED' ? 'verified' : 'rejected'}`,
    body:
      input.status === 'VERIFIED'
        ? `Your ${input.section} details have been verified.`
        : `Your ${input.section} details were rejected: ${input.reason ?? 'no reason given'}`,
    link: '/my-documents',
  })

  return getIdentityProfile(auth, employeeId)
}

/** Reading an unmasked number is itself an audited event (plan section 40). */
export async function revealSensitive(
  auth: AuthContext,
  employeeId: string,
  section: 'PAN' | 'AADHAAR' | 'BANK',
  context: AuditContext,
) {
  if (!auth.has(PERMISSIONS.SENSITIVE_DATA_VIEW) && auth.employeeId !== employeeId) {
    throw ApiError.forbidden('You do not have permission to view this information')
  }
  await assertCanRead(auth, employeeId)

  let value: string | null = null
  if (section === 'PAN') value = (await repository.findPan(employeeId))?.pan_number ?? null
  if (section === 'AADHAAR') value = (await repository.findAadhaar(employeeId))?.aadhaar_number ?? null
  if (section === 'BANK') value = (await repository.findPrimaryBankAccount(employeeId))?.account_number ?? null

  if (!value) throw ApiError.notFound(`${section} details`)

  await recordAudit({
    ...context,
    action: 'SENSITIVE_DATA_VIEWED',
    entityType: 'employee',
    entityId: employeeId,
    newValues: { section },
  })

  return { section, value }
}
