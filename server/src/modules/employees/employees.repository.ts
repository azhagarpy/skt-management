import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { buildUpdate } from '../organization/organization.repository.js'
import { offsetOf, safeSort } from '../../utils/pagination.js'
import type { EmployeeListQuery } from './employees.validation.js'
import type { ScopeClause } from './employee-access.js'

export interface EmployeeRow {
  id: string
  organization_id: string
  user_id: string | null
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  gender: string
  date_of_birth: string | null
  marital_status: string
  blood_group: string | null
  parent_name: string | null
  personal_email: string | null
  work_email: string | null
  mobile_number: string | null
  alternate_number: string | null
  photo_path: string | null
  photo_mime_type: string | null
  photo_updated_at: Date | null
  department_id: string | null
  designation_id: string | null
  location_id: string | null
  supervisor_id: string | null
  is_supervisor: boolean
  employment_type: string
  employment_status: string
  salary_basis: string
  employee_type: string
  plant: string | null
  skill_category: string | null
  duties: string | null
  overtime_rate_override_minor: number | null
  joining_date: string
  confirmation_date: string | null
  notice_start_date: string | null
  exit_date: string | null
  exit_reason: string | null
  created_at: Date
  updated_at: Date
}

export interface EmployeeListRow extends EmployeeRow {
  department_name: string | null
  designation_name: string | null
  location_name: string | null
  supervisor_name: string | null
  user_email: string | null
  user_role: string | null
  user_status: string | null
}

const LIST_COLUMNS = `
  e.*,
  d.name AS department_name,
  g.name AS designation_name,
  l.name AS location_name,
  CASE WHEN s.id IS NULL THEN NULL
       ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name,
  u.email AS user_email,
  u.role  AS user_role,
  u.status AS user_status
`

const LIST_JOINS = `
  FROM employees e
  LEFT JOIN departments  d ON d.id = e.department_id
  LEFT JOIN designations g ON g.id = e.designation_id
  LEFT JOIN locations    l ON l.id = e.location_id
  LEFT JOIN employees    s ON s.id = e.supervisor_id
  LEFT JOIN users        u ON u.id = e.user_id
`

const SORTABLE_COLUMNS: Record<string, string> = {
  employeeCode: 'e.employee_code',
  firstName: 'e.first_name',
  lastName: 'e.last_name',
  joiningDate: 'e.joining_date',
  department: 'd.name',
  designation: 'g.name',
  employmentStatus: 'e.employment_status',
  createdAt: 'e.created_at',
}

/**
 * Builds the WHERE clause shared by the list and count queries so the two can
 * never drift apart.
 */
function buildFilters(scope: ScopeClause, filters: EmployeeListQuery): { clause: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = [...scope.params]

  // Scope placeholders already consumed $1..$n.
  conditions.push(`(${scope.sql})`)

  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  if (filters.search) {
    const index = push(`%${filters.search.trim()}%`)
    conditions.push(`(
      e.employee_code ILIKE $${index}
      OR e.first_name ILIKE $${index}
      OR e.last_name ILIKE $${index}
      OR (e.first_name || ' ' || coalesce(e.last_name, '')) ILIKE $${index}
      OR e.work_email ILIKE $${index}
      OR e.personal_email ILIKE $${index}
      OR e.mobile_number ILIKE $${index}
      OR d.name ILIKE $${index}
      OR g.name ILIKE $${index}
    )`)
  }
  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.designationId) conditions.push(`e.designation_id = $${push(filters.designationId)}`)
  if (filters.locationId) conditions.push(`e.location_id = $${push(filters.locationId)}`)
  if (filters.supervisorId) conditions.push(`e.supervisor_id = $${push(filters.supervisorId)}`)
  if (filters.employmentStatus) conditions.push(`e.employment_status = $${push(filters.employmentStatus)}`)
  if (filters.employmentType) conditions.push(`e.employment_type = $${push(filters.employmentType)}`)
  if (filters.salaryBasis) conditions.push(`e.salary_basis = $${push(filters.salaryBasis)}`)
  if (filters.employeeType) conditions.push(`e.employee_type = $${push(filters.employeeType)}`)
  if (filters.plant) conditions.push(`e.plant = $${push(filters.plant)}`)
  if (filters.isSupervisor !== undefined) conditions.push(`e.is_supervisor = $${push(filters.isSupervisor)}`)
  if (filters.joinedFrom) conditions.push(`e.joining_date >= $${push(filters.joinedFrom)}`)
  if (filters.joinedTo) conditions.push(`e.joining_date <= $${push(filters.joinedTo)}`)

  return { clause: conditions.join(' AND '), params }
}

export async function listEmployees(
  scope: ScopeClause,
  filters: EmployeeListQuery,
  db: Queryable = pool,
): Promise<{ rows: EmployeeListRow[]; total: number }> {
  const { clause, params } = buildFilters(scope, filters)
  const order = safeSort(filters.sortBy, filters.sortOrder, SORTABLE_COLUMNS, 'e.employee_code')

  const countRow = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count ${LIST_JOINS} WHERE ${clause}`,
    params,
  )

  const rows = await queryRows<EmployeeListRow>(
    db,
    `SELECT ${LIST_COLUMNS} ${LIST_JOINS}
      WHERE ${clause}
      ORDER BY ${order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offsetOf(filters.page, filters.pageSize)],
  )

  return { rows, total: Number(countRow?.count ?? 0) }
}

export async function findEmployeeById(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<EmployeeListRow | null> {
  return queryOne<EmployeeListRow>(
    db,
    `SELECT ${LIST_COLUMNS} ${LIST_JOINS} WHERE e.id = $1 AND e.organization_id = $2`,
    [id, organizationId],
  )
}

export async function findEmployeeByCode(
  code: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<EmployeeRow | null> {
  return queryOne<EmployeeRow>(
    db,
    'SELECT * FROM employees WHERE upper(employee_code) = upper($1) AND organization_id = $2',
    [code, organizationId],
  )
}

export async function insertEmployee(values: Record<string, unknown>, db: Queryable = pool): Promise<EmployeeRow> {
  const row = await queryOne<EmployeeRow>(
    db,
    `INSERT INTO employees (
       organization_id, user_id, employee_code, first_name, middle_name, last_name,
       gender, date_of_birth, marital_status, blood_group, parent_name, personal_email, work_email,
       mobile_number, alternate_number, department_id, designation_id, location_id,
       supervisor_id, is_supervisor, employment_type, employment_status, salary_basis,
       employee_type, plant, skill_category, duties, overtime_rate_override_minor,
       joining_date, confirmation_date, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $31
     ) RETURNING *`,
    [
      values.organization_id,
      values.user_id ?? null,
      values.employee_code,
      values.first_name,
      values.middle_name ?? null,
      values.last_name ?? null,
      values.gender ?? 'UNDISCLOSED',
      values.date_of_birth ?? null,
      values.marital_status ?? 'UNDISCLOSED',
      values.blood_group ?? null,
      values.parent_name ?? null,
      values.personal_email ?? null,
      values.work_email ?? null,
      values.mobile_number ?? null,
      values.alternate_number ?? null,
      values.department_id ?? null,
      values.designation_id ?? null,
      values.location_id ?? null,
      values.supervisor_id ?? null,
      values.is_supervisor ?? false,
      values.employment_type ?? 'FULL_TIME',
      values.employment_status ?? 'ACTIVE',
      values.salary_basis ?? 'MONTHLY',
      values.employee_type ?? 'SUPPLY',
      values.plant ?? null,
      values.skill_category ?? null,
      values.duties ?? null,
      values.overtime_rate_override_minor ?? null,
      values.joining_date,
      values.confirmation_date ?? null,
      values.created_by ?? null,
    ],
  )
  return row as EmployeeRow
}

export async function updateEmployee(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<EmployeeRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) {
    return queryOne<EmployeeRow>(db, 'SELECT * FROM employees WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ])
  }
  return queryOne<EmployeeRow>(
    db,
    `UPDATE employees SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function deleteEmployee(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM employees WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

/** True when the employee is referenced by records that must not lose their subject. */
export async function hasFinancialHistory(id: string, db: Queryable = pool): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM payroll_items WHERE employee_id = $1
       UNION ALL
       SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1
     ) AS exists`,
    [id],
  )
  return row?.exists ?? false
}

// ---------------------------------------------------------------------------
// Addresses and emergency contacts
// ---------------------------------------------------------------------------

export interface AddressRow {
  id: string
  employee_id: string
  address_type: string
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  country: string
  pincode: string
}

export async function listAddresses(employeeId: string, db: Queryable = pool): Promise<AddressRow[]> {
  return queryRows<AddressRow>(db, 'SELECT * FROM employee_addresses WHERE employee_id = $1 ORDER BY address_type', [
    employeeId,
  ])
}

export async function upsertAddress(
  employeeId: string,
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<AddressRow> {
  const row = await queryOne<AddressRow>(
    db,
    `INSERT INTO employee_addresses (employee_id, address_type, address_line1, address_line2, city, state, country, pincode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (employee_id, address_type) DO UPDATE
       SET address_line1 = EXCLUDED.address_line1,
           address_line2 = EXCLUDED.address_line2,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           country = EXCLUDED.country,
           pincode = EXCLUDED.pincode
     RETURNING *`,
    [
      employeeId,
      values.address_type,
      values.address_line1,
      values.address_line2 ?? null,
      values.city,
      values.state,
      values.country ?? 'India',
      values.pincode,
    ],
  )
  return row as AddressRow
}

export interface EmergencyContactRow {
  id: string
  employee_id: string
  name: string
  relationship: string
  phone: string
  alternate_phone: string | null
  address: string | null
  is_primary: boolean
}

export async function listEmergencyContacts(
  employeeId: string,
  db: Queryable = pool,
): Promise<EmergencyContactRow[]> {
  return queryRows<EmergencyContactRow>(
    db,
    'SELECT * FROM employee_emergency_contacts WHERE employee_id = $1 ORDER BY is_primary DESC, name',
    [employeeId],
  )
}

export async function replacePrimaryEmergencyContact(
  employeeId: string,
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<EmergencyContactRow> {
  await db.query('DELETE FROM employee_emergency_contacts WHERE employee_id = $1 AND is_primary', [employeeId])
  const row = await queryOne<EmergencyContactRow>(
    db,
    `INSERT INTO employee_emergency_contacts (employee_id, name, relationship, phone, alternate_phone, address, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     RETURNING *`,
    [employeeId, values.name, values.relationship, values.phone, values.alternate_phone ?? null, values.address ?? null],
  )
  return row as EmergencyContactRow
}

// ---------------------------------------------------------------------------
// Job history
// ---------------------------------------------------------------------------

export interface JobHistoryRow {
  id: string
  employee_id: string
  change_type: string
  effective_from: string
  department_id: string | null
  designation_id: string | null
  location_id: string | null
  supervisor_id: string | null
  employment_type: string | null
  employment_status: string | null
  employee_type: string | null
  plant: string | null
  notes: string | null
  created_at: Date
  department_name: string | null
  designation_name: string | null
  supervisor_name: string | null
}

export async function listJobHistory(employeeId: string, db: Queryable = pool): Promise<JobHistoryRow[]> {
  return queryRows<JobHistoryRow>(
    db,
    `SELECT h.*,
            d.name AS department_name,
            g.name AS designation_name,
            CASE WHEN s.id IS NULL THEN NULL
                 ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name
       FROM employee_job_history h
       LEFT JOIN departments  d ON d.id = h.department_id
       LEFT JOIN designations g ON g.id = h.designation_id
       LEFT JOIN employees    s ON s.id = h.supervisor_id
      WHERE h.employee_id = $1
      ORDER BY h.effective_from DESC, h.created_at DESC`,
    [employeeId],
  )
}

export async function insertJobHistory(values: Record<string, unknown>, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO employee_job_history
       (organization_id, employee_id, change_type, effective_from, department_id, designation_id,
        location_id, supervisor_id, employment_type, employment_status, employee_type, plant, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      values.organization_id,
      values.employee_id,
      values.change_type,
      values.effective_from,
      values.department_id ?? null,
      values.designation_id ?? null,
      values.location_id ?? null,
      values.supervisor_id ?? null,
      values.employment_type ?? null,
      values.employment_status ?? null,
      values.employee_type ?? null,
      values.plant ?? null,
      values.notes ?? null,
      values.created_by ?? null,
    ],
  )
}

// ---------------------------------------------------------------------------
// Profile completion (plan sections 12 and 45)
// ---------------------------------------------------------------------------

export interface CompletionRow {
  employee_id: string
  has_personal: boolean
  has_pan: boolean
  pan_status: string | null
  has_aadhaar: boolean
  aadhaar_status: string | null
  has_bank: boolean
  bank_status: string | null
  has_pf: boolean
  pf_status: string | null
  has_esi: boolean
  esi_status: string | null
}

const COMPLETION_SELECT = `
  SELECT e.id AS employee_id,
         (e.mobile_number IS NOT NULL
            AND e.date_of_birth IS NOT NULL
            AND (e.personal_email IS NOT NULL OR e.work_email IS NOT NULL)
            AND EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id)
         ) AS has_personal,
         (pan.id IS NOT NULL) AS has_pan,
         pan.verification_status::text AS pan_status,
         (aadhaar.id IS NOT NULL) AS has_aadhaar,
         aadhaar.verification_status::text AS aadhaar_status,
         (bank.id IS NOT NULL) AS has_bank,
         bank.verification_status::text AS bank_status,
         (pf.id IS NOT NULL) AS has_pf,
         pf.verification_status::text AS pf_status,
         (esi.id IS NOT NULL) AS has_esi,
         esi.verification_status::text AS esi_status
    FROM employees e
    LEFT JOIN employee_pan_details     pan     ON pan.employee_id = e.id
    LEFT JOIN employee_aadhaar_details aadhaar ON aadhaar.employee_id = e.id
    LEFT JOIN employee_bank_accounts   bank    ON bank.employee_id = e.id AND bank.is_primary
    LEFT JOIN employee_pf_details      pf      ON pf.employee_id = e.id
    LEFT JOIN employee_esi_details     esi     ON esi.employee_id = e.id
`

export async function findCompletion(employeeId: string, db: Queryable = pool): Promise<CompletionRow | null> {
  return queryOne<CompletionRow>(db, `${COMPLETION_SELECT} WHERE e.id = $1`, [employeeId])
}

export async function listCompletion(
  employeeIds: string[],
  db: Queryable = pool,
): Promise<CompletionRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<CompletionRow>(db, `${COMPLETION_SELECT} WHERE e.id = ANY($1::uuid[])`, [employeeIds])
}

/** Employees whose required document set is incomplete, for the admin dashboard. */
export async function countIncompleteProfiles(organizationId: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count
       FROM (${COMPLETION_SELECT} WHERE e.organization_id = $1 AND e.employment_status = 'ACTIVE') c
      WHERE NOT (c.has_personal AND c.has_pan AND c.has_aadhaar AND c.has_bank AND c.has_pf AND c.has_esi)`,
    [organizationId],
  )
  return Number(row?.count ?? 0)
}

/** Employee ids supervised by the given supervisor, used to scope team queries. */
export async function listTeamEmployeeIds(supervisorEmployeeId: string, db: Queryable = pool): Promise<string[]> {
  const rows = await queryRows<{ id: string }>(db, 'SELECT id FROM employees WHERE supervisor_id = $1', [
    supervisorEmployeeId,
  ])
  return rows.map((row) => row.id)
}
