import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'

export interface OrganizationRow {
  id: string
  name: string
  legal_name: string | null
  code: string
  email: string | null
  phone: string | null
  website: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  country: string
  pincode: string | null
  pf_number: string | null
  esi_number: string | null
  /** LIN of the establishment, printed on the statutory Letter of Appointment. */
  labour_identification_number: string | null
  logo_path: string | null
  logo_mime_type: 'image/png' | 'image/jpeg' | null
  logo_updated_at: Date | null
  theme_color: string
  currency_code: string
  timezone: string
  fiscal_year_start_month: number
  is_active: boolean
}

export interface DepartmentRow {
  id: string
  organization_id: string
  parent_department_id: string | null
  name: string
  code: string
  description: string | null
  head_employee_id: string | null
  is_active: boolean
  employee_count?: string
}

export interface DesignationRow {
  id: string
  organization_id: string
  department_id: string | null
  name: string
  code: string
  description: string | null
  level: number | null
  is_active: boolean
  employee_count?: string
}

export interface LocationRow {
  id: string
  organization_id: string
  name: string
  code: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  country: string
  pincode: string | null
  timezone: string | null
  is_active: boolean
  employee_count?: string
}

export interface SettingRow {
  id: string
  category: string
  key: string
  value: unknown
  description: string | null
  updated_at: Date
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export async function findOrganization(id: string, db: Queryable = pool): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(db, 'SELECT * FROM organizations WHERE id = $1', [id])
}

/**
 * Builds a partial UPDATE from a map of column -> value, skipping `undefined`.
 * Column names are supplied by the calling repository, never by the client.
 */
export function buildUpdate(
  updates: Record<string, unknown>,
  startIndex: number,
): { assignments: string[]; params: unknown[] } {
  const assignments: string[] = []
  const params: unknown[] = []
  let index = startIndex
  for (const [column, value] of Object.entries(updates)) {
    if (value === undefined) continue
    assignments.push(`${column} = $${index}`)
    params.push(value)
    index += 1
  }
  return { assignments, params }
}

export async function updateOrganization(
  id: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<OrganizationRow | null> {
  const { assignments, params } = buildUpdate(updates, 2)
  if (assignments.length === 0) return findOrganization(id, db)
  return queryOne<OrganizationRow>(
    db,
    `UPDATE organizations SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...params],
  )
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function listDepartments(
  organizationId: string,
  filters: { search?: string; isActive?: boolean; includeCounts?: boolean },
  db: Queryable = pool,
): Promise<DepartmentRow[]> {
  const conditions = ['d.organization_id = $1']
  const params: unknown[] = [organizationId]

  if (filters.search) {
    params.push(`%${filters.search}%`)
    conditions.push(`(d.name ILIKE $${params.length} OR d.code ILIKE $${params.length})`)
  }
  if (filters.isActive !== undefined) {
    params.push(filters.isActive)
    conditions.push(`d.is_active = $${params.length}`)
  }

  const countColumn = filters.includeCounts
    ? `, (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.employment_status = 'ACTIVE')::text AS employee_count`
    : ''

  return queryRows<DepartmentRow>(
    db,
    `SELECT d.*${countColumn} FROM departments d WHERE ${conditions.join(' AND ')} ORDER BY d.name ASC`,
    params,
  )
}

export async function findDepartment(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<DepartmentRow | null> {
  return queryOne<DepartmentRow>(db, 'SELECT * FROM departments WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertDepartment(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<DepartmentRow> {
  const row = await queryOne<DepartmentRow>(
    db,
    `INSERT INTO departments (organization_id, name, code, description, parent_department_id, head_employee_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.description ?? null,
      values.parent_department_id ?? null,
      values.head_employee_id ?? null,
      values.is_active ?? true,
    ],
  )
  return row as DepartmentRow
}

export async function updateDepartment(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<DepartmentRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findDepartment(id, organizationId, db)
  return queryOne<DepartmentRow>(
    db,
    `UPDATE departments SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function countEmployeesInDepartment(id: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM employees WHERE department_id = $1',
    [id],
  )
  return Number(row?.count ?? 0)
}

export async function deleteDepartment(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM departments WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Employee (supply) types
// ---------------------------------------------------------------------------

export interface EmployeeTypeRow {
  id: string
  organization_id: string
  name: string
  code: string
  description: string | null
  overtime_handling: string
  is_active: boolean
  display_order: number
  created_at: Date
  updated_at: Date
  employee_count?: string
}

export async function listEmployeeTypes(
  organizationId: string,
  filters: { search?: string; isActive?: boolean },
  db: Queryable = pool,
): Promise<EmployeeTypeRow[]> {
  const conditions = ['t.organization_id = $1']
  const params: unknown[] = [organizationId]
  if (filters.search) {
    params.push(`%${filters.search}%`)
    conditions.push(`(t.name ILIKE $${params.length} OR t.code ILIKE $${params.length})`)
  }
  if (filters.isActive !== undefined) {
    params.push(filters.isActive)
    conditions.push(`t.is_active = $${params.length}`)
  }
  return queryRows<EmployeeTypeRow>(
    db,
    `SELECT t.*, (SELECT count(*)::text FROM employees e WHERE e.employee_type_id = t.id) AS employee_count
       FROM employee_types t
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.display_order, t.name`,
    params,
  )
}

export async function findEmployeeType(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<EmployeeTypeRow | null> {
  return queryOne<EmployeeTypeRow>(db, 'SELECT * FROM employee_types WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertEmployeeType(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<EmployeeTypeRow> {
  const row = await queryOne<EmployeeTypeRow>(
    db,
    `INSERT INTO employee_types (organization_id, name, code, description, overtime_handling, display_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.description ?? null,
      values.overtime_handling,
      values.display_order ?? 0,
      values.is_active ?? true,
    ],
  )
  return row as EmployeeTypeRow
}

export async function updateEmployeeType(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<EmployeeTypeRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findEmployeeType(id, organizationId, db)
  return queryOne<EmployeeTypeRow>(
    db,
    `UPDATE employee_types SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function countEmployeesWithType(id: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM employees WHERE employee_type_id = $1',
    [id],
  )
  return Number(row?.count ?? 0)
}

export async function deleteEmployeeType(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM employee_types WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

export async function listDesignations(
  organizationId: string,
  filters: { search?: string; isActive?: boolean; includeCounts?: boolean },
  db: Queryable = pool,
): Promise<DesignationRow[]> {
  const conditions = ['g.organization_id = $1']
  const params: unknown[] = [organizationId]

  if (filters.search) {
    params.push(`%${filters.search}%`)
    conditions.push(`(g.name ILIKE $${params.length} OR g.code ILIKE $${params.length})`)
  }
  if (filters.isActive !== undefined) {
    params.push(filters.isActive)
    conditions.push(`g.is_active = $${params.length}`)
  }

  const countColumn = filters.includeCounts
    ? `, (SELECT count(*) FROM employees e WHERE e.designation_id = g.id AND e.employment_status = 'ACTIVE')::text AS employee_count`
    : ''

  return queryRows<DesignationRow>(
    db,
    `SELECT g.*${countColumn} FROM designations g WHERE ${conditions.join(' AND ')} ORDER BY g.name ASC`,
    params,
  )
}

export async function findDesignation(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<DesignationRow | null> {
  return queryOne<DesignationRow>(db, 'SELECT * FROM designations WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertDesignation(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<DesignationRow> {
  const row = await queryOne<DesignationRow>(
    db,
    `INSERT INTO designations (organization_id, name, code, description, department_id, level, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.description ?? null,
      values.department_id ?? null,
      values.level ?? null,
      values.is_active ?? true,
    ],
  )
  return row as DesignationRow
}

export async function updateDesignation(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<DesignationRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findDesignation(id, organizationId, db)
  return queryOne<DesignationRow>(
    db,
    `UPDATE designations SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function countEmployeesWithDesignation(id: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM employees WHERE designation_id = $1',
    [id],
  )
  return Number(row?.count ?? 0)
}

export async function deleteDesignation(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM designations WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function listLocations(
  organizationId: string,
  filters: { search?: string; isActive?: boolean; includeCounts?: boolean },
  db: Queryable = pool,
): Promise<LocationRow[]> {
  const conditions = ['l.organization_id = $1']
  const params: unknown[] = [organizationId]

  if (filters.search) {
    params.push(`%${filters.search}%`)
    conditions.push(`(l.name ILIKE $${params.length} OR l.code ILIKE $${params.length} OR l.city ILIKE $${params.length})`)
  }
  if (filters.isActive !== undefined) {
    params.push(filters.isActive)
    conditions.push(`l.is_active = $${params.length}`)
  }

  const countColumn = filters.includeCounts
    ? `, (SELECT count(*) FROM employees e WHERE e.location_id = l.id AND e.employment_status = 'ACTIVE')::text AS employee_count`
    : ''

  return queryRows<LocationRow>(
    db,
    `SELECT l.*${countColumn} FROM locations l WHERE ${conditions.join(' AND ')} ORDER BY l.name ASC`,
    params,
  )
}

export async function findLocation(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<LocationRow | null> {
  return queryOne<LocationRow>(db, 'SELECT * FROM locations WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertLocation(values: Record<string, unknown>, db: Queryable = pool): Promise<LocationRow> {
  const row = await queryOne<LocationRow>(
    db,
    `INSERT INTO locations (organization_id, name, code, address_line1, address_line2, city, state, country, pincode, timezone, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.address_line1 ?? null,
      values.address_line2 ?? null,
      values.city ?? null,
      values.state ?? null,
      values.country ?? 'India',
      values.pincode ?? null,
      values.timezone ?? null,
      values.is_active ?? true,
    ],
  )
  return row as LocationRow
}

export async function updateLocation(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<LocationRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findLocation(id, organizationId, db)
  return queryOne<LocationRow>(
    db,
    `UPDATE locations SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function countEmployeesAtLocation(id: string, db: Queryable = pool): Promise<number> {
  const row = await queryOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM employees WHERE location_id = $1',
    [id],
  )
  return Number(row?.count ?? 0)
}

export async function deleteLocation(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM locations WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function listSettings(
  organizationId: string,
  category: string | undefined,
  db: Queryable = pool,
): Promise<SettingRow[]> {
  const params: unknown[] = [organizationId]
  let clause = 'organization_id = $1'
  if (category) {
    params.push(category)
    clause += ` AND category = $${params.length}`
  }
  return queryRows<SettingRow>(
    db,
    `SELECT id, category, key, value, description, updated_at FROM system_settings WHERE ${clause} ORDER BY category, key`,
    params,
  )
}

export async function upsertSetting(
  params: { organizationId: string; category: string; key: string; value: unknown; description?: string | null; userId: string },
  db: Queryable = pool,
): Promise<SettingRow> {
  const row = await queryOne<SettingRow>(
    db,
    `INSERT INTO system_settings (organization_id, category, key, value, description, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (organization_id, category, key)
     DO UPDATE SET value = EXCLUDED.value,
                   description = COALESCE(EXCLUDED.description, system_settings.description),
                   updated_by = EXCLUDED.updated_by
     RETURNING id, category, key, value, description, updated_at`,
    [
      params.organizationId,
      params.category,
      params.key,
      JSON.stringify(params.value ?? null),
      params.description ?? null,
      params.userId,
    ],
  )
  return row as SettingRow
}

export async function getSettingValue<T>(
  organizationId: string,
  category: string,
  key: string,
  fallback: T,
  db: Queryable = pool,
): Promise<T> {
  const row = await queryOne<{ value: T }>(
    db,
    'SELECT value FROM system_settings WHERE organization_id = $1 AND category = $2 AND key = $3',
    [organizationId, category, key],
  )
  return row ? row.value : fallback
}
