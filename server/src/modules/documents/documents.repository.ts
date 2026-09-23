import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'

export interface DocumentRow {
  id: string
  organization_id: string
  employee_id: string
  category: string
  title: string
  storage_key: string
  original_filename: string
  mime_type: string
  file_size_bytes: string
  checksum_sha256: string | null
  verification_status: string
  verified_by: string | null
  verified_at: Date | null
  rejection_reason: string | null
  uploaded_by: string | null
  created_at: Date
  updated_at: Date
}

export interface PanRow {
  id: string
  employee_id: string
  pan_number: string
  pan_name: string
  document_id: string | null
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  updated_at: Date
}

export interface AadhaarRow {
  id: string
  employee_id: string
  aadhaar_number: string
  aadhaar_last4: string
  aadhaar_name: string
  document_id: string | null
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  updated_at: Date
}

export interface BankAccountRow {
  id: string
  employee_id: string
  account_holder_name: string
  bank_name: string
  account_number: string
  account_last4: string
  ifsc_code: string
  branch_name: string | null
  account_type: string
  is_primary: boolean
  document_id: string | null
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  updated_at: Date
}

export interface PfRow {
  id: string
  employee_id: string
  pf_applicable: boolean
  uan_number: string | null
  pf_member_id: string | null
  pf_name: string | null
  pension_applicable: boolean
  employee_contribution_percent: string | null
  employer_contribution_percent: string | null
  document_id: string | null
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  updated_at: Date
}

export interface EsiRow {
  id: string
  employee_id: string
  esi_applicable: boolean
  esi_number: string | null
  esi_name: string | null
  employee_contribution_percent: string | null
  employer_contribution_percent: string | null
  document_id: string | null
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  updated_at: Date
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listDocuments(
  employeeId: string,
  filters: { category?: string; verificationStatus?: string },
  db: Queryable = pool,
): Promise<DocumentRow[]> {
  const conditions = ['employee_id = $1']
  const params: unknown[] = [employeeId]
  if (filters.category) {
    params.push(filters.category)
    conditions.push(`category = $${params.length}`)
  }
  if (filters.verificationStatus) {
    params.push(filters.verificationStatus)
    conditions.push(`verification_status = $${params.length}`)
  }
  return queryRows<DocumentRow>(
    db,
    `SELECT * FROM employee_documents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params,
  )
}

export async function findDocument(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(db, 'SELECT * FROM employee_documents WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertDocument(values: Record<string, unknown>, db: Queryable = pool): Promise<DocumentRow> {
  const row = await queryOne<DocumentRow>(
    db,
    `INSERT INTO employee_documents
       (organization_id, employee_id, category, title, storage_key, original_filename,
        mime_type, file_size_bytes, checksum_sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.category,
      values.title,
      values.storage_key,
      values.original_filename,
      values.mime_type,
      values.file_size_bytes,
      values.checksum_sha256 ?? null,
      values.uploaded_by ?? null,
    ],
  )
  return row as DocumentRow
}

export async function setDocumentVerification(
  id: string,
  organizationId: string,
  status: 'VERIFIED' | 'REJECTED',
  verifiedBy: string,
  reason: string | null,
  db: Queryable = pool,
): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(
    db,
    `UPDATE employee_documents
        SET verification_status = $3,
            verified_by = $4,
            verified_at = now(),
            rejection_reason = $5
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [id, organizationId, status, verifiedBy, reason],
  )
}

export async function deleteDocument(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM employee_documents WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// PAN
// ---------------------------------------------------------------------------

export async function findPan(employeeId: string, db: Queryable = pool): Promise<PanRow | null> {
  return queryOne<PanRow>(db, 'SELECT * FROM employee_pan_details WHERE employee_id = $1', [employeeId])
}

export async function upsertPan(values: Record<string, unknown>, db: Queryable = pool): Promise<PanRow> {
  const row = await queryOne<PanRow>(
    db,
    `INSERT INTO employee_pan_details (organization_id, employee_id, pan_number, pan_name, document_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id) DO UPDATE
       SET pan_number = EXCLUDED.pan_number,
           pan_name = EXCLUDED.pan_name,
           document_id = COALESCE(EXCLUDED.document_id, employee_pan_details.document_id),
           -- Any edit re-opens verification.
           verification_status = 'PENDING',
           verified_by = NULL,
           verified_at = NULL,
           rejection_reason = NULL
     RETURNING *`,
    [values.organization_id, values.employee_id, values.pan_number, values.pan_name, values.document_id ?? null],
  )
  return row as PanRow
}

// ---------------------------------------------------------------------------
// Aadhaar
// ---------------------------------------------------------------------------

export async function findAadhaar(employeeId: string, db: Queryable = pool): Promise<AadhaarRow | null> {
  return queryOne<AadhaarRow>(db, 'SELECT * FROM employee_aadhaar_details WHERE employee_id = $1', [employeeId])
}

export async function upsertAadhaar(values: Record<string, unknown>, db: Queryable = pool): Promise<AadhaarRow> {
  const row = await queryOne<AadhaarRow>(
    db,
    `INSERT INTO employee_aadhaar_details
       (organization_id, employee_id, aadhaar_number, aadhaar_last4, aadhaar_name, document_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id) DO UPDATE
       SET aadhaar_number = EXCLUDED.aadhaar_number,
           aadhaar_last4 = EXCLUDED.aadhaar_last4,
           aadhaar_name = EXCLUDED.aadhaar_name,
           document_id = COALESCE(EXCLUDED.document_id, employee_aadhaar_details.document_id),
           verification_status = 'PENDING',
           verified_by = NULL,
           verified_at = NULL,
           rejection_reason = NULL
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.aadhaar_number,
      values.aadhaar_last4,
      values.aadhaar_name,
      values.document_id ?? null,
    ],
  )
  return row as AadhaarRow
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export async function findPrimaryBankAccount(
  employeeId: string,
  db: Queryable = pool,
): Promise<BankAccountRow | null> {
  return queryOne<BankAccountRow>(
    db,
    'SELECT * FROM employee_bank_accounts WHERE employee_id = $1 AND is_primary ORDER BY updated_at DESC LIMIT 1',
    [employeeId],
  )
}

export async function listBankAccounts(employeeId: string, db: Queryable = pool): Promise<BankAccountRow[]> {
  return queryRows<BankAccountRow>(
    db,
    'SELECT * FROM employee_bank_accounts WHERE employee_id = $1 ORDER BY is_primary DESC, updated_at DESC',
    [employeeId],
  )
}

export async function clearPrimaryBankAccount(employeeId: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE employee_bank_accounts SET is_primary = FALSE WHERE employee_id = $1 AND is_primary', [
    employeeId,
  ])
}

export async function insertBankAccount(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<BankAccountRow> {
  const row = await queryOne<BankAccountRow>(
    db,
    `INSERT INTO employee_bank_accounts
       (organization_id, employee_id, account_holder_name, bank_name, account_number, account_last4,
        ifsc_code, branch_name, account_type, is_primary, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.account_holder_name,
      values.bank_name,
      values.account_number,
      values.account_last4,
      values.ifsc_code,
      values.branch_name ?? null,
      values.account_type,
      values.is_primary,
      values.document_id ?? null,
    ],
  )
  return row as BankAccountRow
}

// ---------------------------------------------------------------------------
// PF and ESI
// ---------------------------------------------------------------------------

export async function findPf(employeeId: string, db: Queryable = pool): Promise<PfRow | null> {
  return queryOne<PfRow>(db, 'SELECT * FROM employee_pf_details WHERE employee_id = $1', [employeeId])
}

export async function upsertPf(values: Record<string, unknown>, db: Queryable = pool): Promise<PfRow> {
  const row = await queryOne<PfRow>(
    db,
    `INSERT INTO employee_pf_details
       (organization_id, employee_id, pf_applicable, uan_number, pf_member_id, pf_name, pension_applicable,
        employee_contribution_percent, employer_contribution_percent, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (employee_id) DO UPDATE
       SET pf_applicable = EXCLUDED.pf_applicable,
           uan_number = EXCLUDED.uan_number,
           pf_member_id = EXCLUDED.pf_member_id,
           pf_name = EXCLUDED.pf_name,
           pension_applicable = EXCLUDED.pension_applicable,
           employee_contribution_percent = EXCLUDED.employee_contribution_percent,
           employer_contribution_percent = EXCLUDED.employer_contribution_percent,
           document_id = COALESCE(EXCLUDED.document_id, employee_pf_details.document_id),
           verification_status = 'PENDING',
           verified_by = NULL,
           verified_at = NULL,
           rejection_reason = NULL
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.pf_applicable,
      values.uan_number ?? null,
      values.pf_member_id ?? null,
      values.pf_name ?? null,
      values.pension_applicable,
      values.employee_contribution_percent ?? null,
      values.employer_contribution_percent ?? null,
      values.document_id ?? null,
    ],
  )
  return row as PfRow
}

export async function findEsi(employeeId: string, db: Queryable = pool): Promise<EsiRow | null> {
  return queryOne<EsiRow>(db, 'SELECT * FROM employee_esi_details WHERE employee_id = $1', [employeeId])
}

export async function upsertEsi(values: Record<string, unknown>, db: Queryable = pool): Promise<EsiRow> {
  const row = await queryOne<EsiRow>(
    db,
    `INSERT INTO employee_esi_details
       (organization_id, employee_id, esi_applicable, esi_number, esi_name,
        employee_contribution_percent, employer_contribution_percent, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (employee_id) DO UPDATE
       SET esi_applicable = EXCLUDED.esi_applicable,
           esi_number = EXCLUDED.esi_number,
           esi_name = EXCLUDED.esi_name,
           employee_contribution_percent = EXCLUDED.employee_contribution_percent,
           employer_contribution_percent = EXCLUDED.employer_contribution_percent,
           document_id = COALESCE(EXCLUDED.document_id, employee_esi_details.document_id),
           verification_status = 'PENDING',
           verified_by = NULL,
           verified_at = NULL,
           rejection_reason = NULL
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.esi_applicable,
      values.esi_number ?? null,
      values.esi_name ?? null,
      values.employee_contribution_percent ?? null,
      values.employer_contribution_percent ?? null,
      values.document_id ?? null,
    ],
  )
  return row as EsiRow
}

const SECTION_TABLES = {
  PAN: 'employee_pan_details',
  AADHAAR: 'employee_aadhaar_details',
  BANK: 'employee_bank_accounts',
  PF: 'employee_pf_details',
  ESI: 'employee_esi_details',
} as const

export type VerifiableSection = keyof typeof SECTION_TABLES

/** Sets the verification status of one identity/financial section. */
export async function setSectionVerification(
  section: VerifiableSection,
  employeeId: string,
  organizationId: string,
  status: 'VERIFIED' | 'REJECTED',
  verifiedBy: string,
  reason: string | null,
  db: Queryable = pool,
): Promise<boolean> {
  // The table name comes from a closed lookup, never from client input.
  const table = SECTION_TABLES[section]
  const extraClause = section === 'BANK' ? 'AND is_primary' : ''
  const result = await db.query(
    `UPDATE ${table}
        SET verification_status = $3,
            verified_by = $4,
            verified_at = now(),
            rejection_reason = $5
      WHERE employee_id = $1 AND organization_id = $2 ${extraClause}`,
    [employeeId, organizationId, status, verifiedBy, reason],
  )
  return (result.rowCount ?? 0) > 0
}

/** Counts documents awaiting verification, for the admin dashboard. */
export async function countPendingVerifications(organizationId: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    `SELECT (
       (SELECT count(*) FROM employee_documents      WHERE organization_id = $1 AND verification_status = 'PENDING') +
       (SELECT count(*) FROM employee_pan_details    WHERE organization_id = $1 AND verification_status = 'PENDING') +
       (SELECT count(*) FROM employee_aadhaar_details WHERE organization_id = $1 AND verification_status = 'PENDING') +
       (SELECT count(*) FROM employee_bank_accounts  WHERE organization_id = $1 AND verification_status = 'PENDING') +
       (SELECT count(*) FROM employee_pf_details     WHERE organization_id = $1 AND verification_status = 'PENDING') +
       (SELECT count(*) FROM employee_esi_details    WHERE organization_id = $1 AND verification_status = 'PENDING')
     )::text AS count`,
    [organizationId],
  )
  return Number(row?.count ?? 0)
}
