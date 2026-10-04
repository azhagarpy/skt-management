import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { buildUpdate } from '../organization/organization.repository.js'
import type { IsoDate } from '../../utils/dates.js'

export interface SalaryComponentRow {
  id: string
  organization_id: string
  name: string
  code: string
  component_type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  calculation_type: 'FIXED' | 'PERCENTAGE'
  percentage_base: string | null
  base_component_code: string | null
  taxable: boolean
  prorate: boolean
  holiday_extra_pay: boolean
  display_order: number
  is_statutory: boolean
  is_active: boolean
}

export interface SalaryStructureRow {
  id: string
  organization_id: string
  name: string
  code: string
  description: string | null
  salary_basis: 'MONTHLY' | 'DAILY'
  currency_code: string
  is_active: boolean
}

/**
 * One period of a structure's PF and ESI settings, in force from its start
 * date until the day before the next period starts (statutory-rates.ts).
 */
export interface StatutoryRateRow {
  id: string
  salary_structure_id: string
  /** Null for the structure's first period, which covers every date before the next one. */
  effective_from: IsoDate | null
  pf_employee_rate: string
  pf_employer_rate: string
  /** PF is deducted on the wage up to this ceiling; zero means no cap. */
  pf_wage_ceiling: string
  /** Share of pf_employer_rate that goes to the Pension Scheme (EPS). */
  pf_eps_rate: string
  esi_employee_rate: string
  esi_employer_rate: string
  /**
   * ESI applies, on both sides, only when a standard month's wage is at or below
   * this limit, and is deducted on the wage capped at it.
   */
  esi_wage_limit: string
  created_at: Date
  updated_at: Date
}

export interface StructureComponentRow {
  id: string
  salary_structure_id: string
  salary_component_id: string
  calculation_type: 'FIXED' | 'PERCENTAGE'
  amount: string
  percentage: string
  display_order: number
  // Joined from salary_components.
  name: string
  code: string
  component_type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  percentage_base: string | null
  base_component_code: string | null
  taxable: boolean
  prorate: boolean
  holiday_extra_pay: boolean
}

export interface SalaryStructureWithComponents extends SalaryStructureRow {
  components: StructureComponentRow[]
  /** Every PF and ESI period, oldest first. */
  statutory_rates: StatutoryRateRow[]
}

export interface SalaryAssignmentRow {
  id: string
  organization_id: string
  employee_id: string
  salary_structure_id: string
  effective_from: IsoDate
  effective_to: IsoDate | null
  status: string
  override_amount: string | null
  notes: string | null
  created_at: Date
  structure_name?: string
  structure_code?: string
  salary_basis?: 'MONTHLY' | 'DAILY'
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function listComponents(
  organizationId: string,
  activeOnly: boolean,
  db: Queryable = pool,
): Promise<SalaryComponentRow[]> {
  const clause = activeOnly ? 'AND is_active' : ''
  return queryRows<SalaryComponentRow>(
    db,
    `SELECT * FROM salary_components WHERE organization_id = $1 ${clause} ORDER BY display_order, name`,
    [organizationId],
  )
}

export async function findComponent(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<SalaryComponentRow | null> {
  return queryOne<SalaryComponentRow>(db, 'SELECT * FROM salary_components WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function insertComponent(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<SalaryComponentRow> {
  const row = await queryOne<SalaryComponentRow>(
    db,
    `INSERT INTO salary_components
       (organization_id, name, code, component_type, calculation_type, percentage_base, base_component_code,
        taxable, prorate, holiday_extra_pay, display_order, is_statutory, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.component_type,
      values.calculation_type,
      values.percentage_base ?? null,
      values.base_component_code ?? null,
      values.taxable,
      values.prorate,
      values.holiday_extra_pay ?? true,
      values.display_order,
      values.is_statutory,
      values.is_active,
    ],
  )
  return row as SalaryComponentRow
}

export async function updateComponent(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<SalaryComponentRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findComponent(id, organizationId, db)
  return queryOne<SalaryComponentRow>(
    db,
    `UPDATE salary_components SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

/** True when any structure includes this component. */
export async function componentInUse(componentId: string, db: Queryable = pool): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    db,
    'SELECT EXISTS (SELECT 1 FROM salary_structure_components WHERE salary_component_id = $1) AS exists',
    [componentId],
  )
  return row?.exists ?? false
}

export async function deleteComponent(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM salary_components WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

const STRUCTURE_COMPONENT_SELECT = `
  SELECT sc.*,
         c.name, c.code, c.component_type, c.percentage_base, c.base_component_code,
         c.taxable, c.prorate, c.holiday_extra_pay
    FROM salary_structure_components sc
    JOIN salary_components c ON c.id = sc.salary_component_id
`

export async function listStructures(
  organizationId: string,
  activeOnly: boolean,
  db: Queryable = pool,
): Promise<SalaryStructureWithComponents[]> {
  const clause = activeOnly ? 'AND is_active' : ''
  const structures = await queryRows<SalaryStructureRow>(
    db,
    `SELECT * FROM salary_structures WHERE organization_id = $1 ${clause} ORDER BY name`,
    [organizationId],
  )
  if (structures.length === 0) return []

  const components = await queryRows<StructureComponentRow>(
    db,
    `${STRUCTURE_COMPONENT_SELECT} WHERE sc.salary_structure_id = ANY($1::uuid[]) ORDER BY sc.display_order, c.display_order`,
    [structures.map((structure) => structure.id)],
  )

  const byStructure = new Map<string, StructureComponentRow[]>()
  for (const component of components) {
    const list = byStructure.get(component.salary_structure_id) ?? []
    list.push(component)
    byStructure.set(component.salary_structure_id, list)
  }

  const rates = await listStatutoryRates(
    structures.map((structure) => structure.id),
    db,
  )
  const ratesByStructure = new Map<string, StatutoryRateRow[]>()
  for (const rate of rates) {
    const list = ratesByStructure.get(rate.salary_structure_id) ?? []
    list.push(rate)
    ratesByStructure.set(rate.salary_structure_id, list)
  }

  return structures.map((structure) => ({
    ...structure,
    components: byStructure.get(structure.id) ?? [],
    statutory_rates: ratesByStructure.get(structure.id) ?? [],
  }))
}

export async function findStructure(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<SalaryStructureWithComponents | null> {
  const structure = await queryOne<SalaryStructureRow>(
    db,
    'SELECT * FROM salary_structures WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
  if (!structure) return null
  const components = await queryRows<StructureComponentRow>(
    db,
    `${STRUCTURE_COMPONENT_SELECT} WHERE sc.salary_structure_id = $1 ORDER BY sc.display_order, c.display_order`,
    [id],
  )
  const statutoryRates = await listStatutoryRates([id], db)
  return { ...structure, components, statutory_rates: statutoryRates }
}

export async function insertStructure(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<SalaryStructureRow> {
  const row = await queryOne<SalaryStructureRow>(
    db,
    `INSERT INTO salary_structures
       (organization_id, name, code, description, salary_basis, currency_code, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.description ?? null,
      values.salary_basis,
      values.currency_code,
      values.is_active,
      values.created_by ?? null,
    ],
  )
  return row as SalaryStructureRow
}

export async function updateStructure(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<SalaryStructureRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) {
    return queryOne<SalaryStructureRow>(db, 'SELECT * FROM salary_structures WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ])
  }
  return queryOne<SalaryStructureRow>(
    db,
    `UPDATE salary_structures SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function replaceStructureComponents(
  structureId: string,
  components: {
    salaryComponentId: string
    calculationType: string
    amount: number
    percentage: number
    displayOrder: number
  }[],
  db: Queryable = pool,
): Promise<void> {
  await db.query('DELETE FROM salary_structure_components WHERE salary_structure_id = $1', [structureId])
  for (const component of components) {
    await db.query(
      `INSERT INTO salary_structure_components
         (salary_structure_id, salary_component_id, calculation_type, amount, percentage, display_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        structureId,
        component.salaryComponentId,
        component.calculationType,
        component.amount,
        component.percentage,
        component.displayOrder,
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// PF and ESI rate periods
// ---------------------------------------------------------------------------

export async function listStatutoryRates(structureIds: string[], db: Queryable = pool): Promise<StatutoryRateRow[]> {
  if (structureIds.length === 0) return []
  return queryRows<StatutoryRateRow>(
    db,
    `SELECT * FROM salary_structure_statutory_rates
      WHERE salary_structure_id = ANY($1::uuid[])
      ORDER BY salary_structure_id, effective_from NULLS FIRST`,
    [structureIds],
  )
}

export async function findStatutoryRate(
  id: string,
  structureId: string,
  db: Queryable = pool,
): Promise<StatutoryRateRow | null> {
  return queryOne<StatutoryRateRow>(
    db,
    'SELECT * FROM salary_structure_statutory_rates WHERE id = $1 AND salary_structure_id = $2',
    [id, structureId],
  )
}

/** The structure's period starting on a date, or its undated first period when `effectiveFrom` is null. */
export async function findStatutoryRateStarting(
  structureId: string,
  effectiveFrom: IsoDate | null,
  db: Queryable = pool,
): Promise<StatutoryRateRow | null> {
  return queryOne<StatutoryRateRow>(
    db,
    `SELECT * FROM salary_structure_statutory_rates
      WHERE salary_structure_id = $1 AND effective_from IS NOT DISTINCT FROM $2::date`,
    [structureId, effectiveFrom],
  )
}

export async function insertStatutoryRate(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<StatutoryRateRow> {
  const row = await queryOne<StatutoryRateRow>(
    db,
    `INSERT INTO salary_structure_statutory_rates
       (salary_structure_id, effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling, pf_eps_rate,
        esi_employee_rate, esi_employer_rate, esi_wage_limit, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      values.salary_structure_id,
      values.effective_from ?? null,
      values.pf_employee_rate,
      values.pf_employer_rate,
      values.pf_wage_ceiling,
      values.pf_eps_rate,
      values.esi_employee_rate,
      values.esi_employer_rate,
      values.esi_wage_limit,
      values.created_by ?? null,
    ],
  )
  return row as StatutoryRateRow
}

export async function updateStatutoryRate(
  id: string,
  structureId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<StatutoryRateRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findStatutoryRate(id, structureId, db)
  return queryOne<StatutoryRateRow>(
    db,
    `UPDATE salary_structure_statutory_rates SET ${assignments.join(', ')}
      WHERE id = $1 AND salary_structure_id = $2 RETURNING *`,
    [id, structureId, ...params],
  )
}

export async function deleteStatutoryRate(id: string, structureId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM salary_structure_statutory_rates WHERE id = $1 AND salary_structure_id = $2', [
    id,
    structureId,
  ])
  return (result.rowCount ?? 0) > 0
}

/** True when any employee has ever been assigned this structure. */
export async function structureInUse(structureId: string, db: Queryable = pool): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    db,
    'SELECT EXISTS (SELECT 1 FROM employee_salary_assignments WHERE salary_structure_id = $1) AS exists',
    [structureId],
  )
  return row?.exists ?? false
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

const ASSIGNMENT_SELECT = `
  SELECT a.*, s.name AS structure_name, s.code AS structure_code, s.salary_basis
    FROM employee_salary_assignments a
    JOIN salary_structures s ON s.id = a.salary_structure_id
`

export async function listAssignments(
  employeeId: string,
  db: Queryable = pool,
): Promise<SalaryAssignmentRow[]> {
  return queryRows<SalaryAssignmentRow>(
    db,
    `${ASSIGNMENT_SELECT} WHERE a.employee_id = $1 ORDER BY a.effective_from DESC`,
    [employeeId],
  )
}

/** The assignment in force on a date, which is what payroll must use. */
export async function findAssignmentForDate(
  employeeId: string,
  onDate: IsoDate,
  db: Queryable = pool,
): Promise<SalaryAssignmentRow | null> {
  return queryOne<SalaryAssignmentRow>(
    db,
    `${ASSIGNMENT_SELECT}
      WHERE a.employee_id = $1
        AND a.status = 'ACTIVE'
        AND a.effective_from <= $2
        AND (a.effective_to IS NULL OR a.effective_to >= $2)
      ORDER BY a.effective_from DESC
      LIMIT 1`,
    [employeeId, onDate],
  )
}

export async function findAssignmentsForDate(
  employeeIds: string[],
  onDate: IsoDate,
  db: Queryable = pool,
): Promise<SalaryAssignmentRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<SalaryAssignmentRow>(
    db,
    `SELECT DISTINCT ON (a.employee_id) a.*, s.name AS structure_name, s.code AS structure_code, s.salary_basis
       FROM employee_salary_assignments a
       JOIN salary_structures s ON s.id = a.salary_structure_id
      WHERE a.employee_id = ANY($1::uuid[])
        AND a.status = 'ACTIVE'
        AND a.effective_from <= $2
        AND (a.effective_to IS NULL OR a.effective_to >= $2)
      ORDER BY a.employee_id, a.effective_from DESC`,
    [employeeIds, onDate],
  )
}

export async function findOpenAssignment(
  employeeId: string,
  db: Queryable = pool,
): Promise<SalaryAssignmentRow | null> {
  return queryOne<SalaryAssignmentRow>(
    db,
    `${ASSIGNMENT_SELECT}
      WHERE a.employee_id = $1 AND a.status = 'ACTIVE' AND a.effective_to IS NULL
      ORDER BY a.effective_from DESC
      LIMIT 1`,
    [employeeId],
  )
}

/**
 * Closes the previous open assignment the day before the new one starts.
 * Historical rows are never overwritten (plan section 21).
 */
export async function closeAssignment(id: string, effectiveTo: IsoDate, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE employee_salary_assignments SET effective_to = $2 WHERE id = $1', [id, effectiveTo])
}

export async function insertAssignment(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<SalaryAssignmentRow> {
  const row = await queryOne<SalaryAssignmentRow>(
    db,
    `INSERT INTO employee_salary_assignments
       (organization_id, employee_id, salary_structure_id, effective_from, effective_to, override_amount, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.salary_structure_id,
      values.effective_from,
      values.effective_to ?? null,
      values.override_amount ?? null,
      values.notes ?? null,
      values.created_by ?? null,
    ],
  )
  return row as SalaryAssignmentRow
}

