import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { addDays, type IsoDate } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope } from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './salary.repository.js'
import type { AssignSalaryInput, SalaryComponentInput, SalaryStructureInput } from './salary.validation.js'

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export function presentComponent(row: repository.SalaryComponentRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    isActive: row.is_active,
  }
}

/**
 * Totals a structure's fixed components so the UI can show a gross figure.
 * Percentage components are excluded: their value depends on the employee's
 * base, which only the payroll calculator knows.
 */
function summariseStructure(components: repository.StructureComponentRow[]) {
  let earningsMinor = 0
  let deductionsMinor = 0
  let hasPercentage = false

  for (const component of components) {
    if (component.calculation_type === 'PERCENTAGE') {
      hasPercentage = true
      continue
    }
    const amount = toMinor(component.amount)
    if (component.component_type === 'EARNING') earningsMinor += amount
    else if (component.component_type === 'DEDUCTION') deductionsMinor += amount
  }

  return {
    fixedGross: toMajor(earningsMinor),
    fixedDeductions: toMajor(deductionsMinor),
    fixedNet: toMajor(earningsMinor - deductionsMinor),
    hasPercentageComponents: hasPercentage,
  }
}

export function presentStructure(row: repository.SalaryStructureWithComponents) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    salaryBasis: row.salary_basis,
    currencyCode: row.currency_code,
    isActive: row.is_active,
    pfEmployeeRate: Number(row.pf_employee_rate),
    pfEmployerRate: Number(row.pf_employer_rate),
    pfWageCeiling: Number(row.pf_wage_ceiling),
    pfEpsRate: Number(row.pf_eps_rate),
    esiEmployeeRate: Number(row.esi_employee_rate),
    esiEmployerRate: Number(row.esi_employer_rate),
    esiWageLimit: Number(row.esi_wage_limit),
    components: row.components.map((component) => ({
      id: component.id,
      salaryComponentId: component.salary_component_id,
      name: component.name,
      code: component.code,
      componentType: component.component_type,
      calculationType: component.calculation_type,
      amount: Number(component.amount),
      percentage: Number(component.percentage),
      percentageBase: component.percentage_base,
      baseComponentCode: component.base_component_code,
      taxable: component.taxable,
      prorate: component.prorate,
      displayOrder: component.display_order,
    })),
    summary: summariseStructure(row.components),
  }
}

export function presentAssignment(row: repository.SalaryAssignmentRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    salaryStructureId: row.salary_structure_id,
    structureName: row.structure_name ?? null,
    structureCode: row.structure_code ?? null,
    salaryBasis: row.salary_basis ?? null,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    overrideAmount: row.override_amount === null ? null : Number(row.override_amount),
    notes: row.notes,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function listComponents(auth: AuthContext, activeOnly: boolean) {
  const rows = await repository.listComponents(auth.organizationId, activeOnly)
  return rows.map(presentComponent)
}

// A salary component is always a fixed, taxable, attendance-prorated earning:
// the only choices left to the admin are its name, code and active flag
// (plan: simplified salary module).
const COMPONENT_DEFAULTS = {
  component_type: 'EARNING' as const,
  calculation_type: 'FIXED' as const,
  percentage_base: null,
  base_component_code: null,
  taxable: true,
  prorate: true,
  display_order: 0,
  is_statutory: false,
}

export async function createComponent(auth: AuthContext, input: SalaryComponentInput, context: AuditContext) {
  const row = await repository.insertComponent({
    organization_id: auth.organizationId,
    name: input.name,
    code: input.code,
    ...COMPONENT_DEFAULTS,
    is_active: input.isActive,
  })

  await recordAudit({
    ...context,
    action: 'SALARY_STRUCTURE_CREATED',
    entityType: 'salary_component',
    entityId: row.id,
    newValues: presentComponent(row),
  })

  return presentComponent(row)
}

export async function updateComponent(
  auth: AuthContext,
  id: string,
  input: SalaryComponentInput,
  context: AuditContext,
) {
  const existing = await repository.findComponent(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Salary component')

  const row = await repository.updateComponent(id, auth.organizationId, {
    name: input.name,
    code: input.code,
    ...COMPONENT_DEFAULTS,
    is_active: input.isActive,
  })
  if (!row) throw ApiError.notFound('Salary component')

  await recordAudit({
    ...context,
    action: 'SALARY_STRUCTURE_UPDATED',
    entityType: 'salary_component',
    entityId: id,
    oldValues: presentComponent(existing),
    newValues: presentComponent(row),
  })

  return presentComponent(row)
}

export async function deleteComponent(auth: AuthContext, id: string, context: AuditContext) {
  const existing = await repository.findComponent(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Salary component')

  if (await repository.componentInUse(id)) {
    throw ApiError.businessRule(
      `${existing.name} is used by one or more salary structures and cannot be deleted. Deactivate it instead.`,
    )
  }

  await repository.deleteComponent(id, auth.organizationId)

  await recordAudit({
    ...context,
    action: 'SALARY_COMPONENT_DELETED',
    entityType: 'salary_component',
    entityId: id,
    oldValues: presentComponent(existing),
  })

  return { id }
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export async function listStructures(auth: AuthContext, activeOnly: boolean) {
  const rows = await repository.listStructures(auth.organizationId, activeOnly)
  return rows.map(presentStructure)
}

export async function getStructure(auth: AuthContext, id: string) {
  const row = await repository.findStructure(id, auth.organizationId)
  if (!row) throw ApiError.notFound('Salary structure')
  return presentStructure(row)
}

async function assertComponentsExist(
  organizationId: string,
  componentIds: string[],
  db: Parameters<typeof repository.findComponent>[2],
): Promise<void> {
  for (const componentId of componentIds) {
    const component = await repository.findComponent(componentId, organizationId, db)
    if (!component) throw ApiError.badRequest('One of the selected salary components does not exist')
    if (!component.is_active) throw ApiError.businessRule(`Salary component ${component.name} is inactive`)
  }
}

export async function createStructure(auth: AuthContext, input: SalaryStructureInput, context: AuditContext) {
  const structure = await withTransaction(async (tx) => {
    await assertComponentsExist(
      auth.organizationId,
      input.components.map((component) => component.salaryComponentId),
      tx,
    )

    const created = await repository.insertStructure(
      {
        organization_id: auth.organizationId,
        name: input.name,
        code: input.code,
        description: input.description ?? null,
        salary_basis: input.salaryBasis,
        currency_code: input.currencyCode,
        is_active: input.isActive,
        pf_employee_rate: input.pfEmployeeRate,
        pf_employer_rate: input.pfEmployerRate,
        pf_wage_ceiling: input.pfWageCeiling,
        pf_eps_rate: input.pfEpsRate,
        esi_employee_rate: input.esiEmployeeRate,
        esi_employer_rate: input.esiEmployerRate,
        esi_wage_limit: input.esiWageLimit,
        created_by: auth.userId,
      },
      tx,
    )

    await repository.replaceStructureComponents(
      created.id,
      input.components.map((component, index) => ({
        salaryComponentId: component.salaryComponentId,
        calculationType: component.calculationType,
        amount: component.amount,
        percentage: component.percentage,
        displayOrder: component.displayOrder || index,
      })),
      tx,
    )

    return repository.findStructure(created.id, auth.organizationId, tx)
  })

  await recordAudit({
    ...context,
    action: 'SALARY_STRUCTURE_CREATED',
    entityType: 'salary_structure',
    entityId: structure?.id ?? null,
    newValues: { name: input.name, code: input.code, components: input.components.length },
  })

  return structure ? presentStructure(structure) : null
}

export async function updateStructure(
  auth: AuthContext,
  id: string,
  input: SalaryStructureInput,
  context: AuditContext,
) {
  const existing = await repository.findStructure(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Salary structure')

  // Changing the basis of a structure already used by payroll would silently
  // rewrite how past figures were derived; the correct move is a new structure.
  if (existing.salary_basis !== input.salaryBasis && (await repository.structureInUse(id))) {
    throw ApiError.businessRule(
      'This structure is already assigned to employees, so its salary basis cannot be changed. Create a new structure instead.',
    )
  }

  const structure = await withTransaction(async (tx) => {
    await assertComponentsExist(
      auth.organizationId,
      input.components.map((component) => component.salaryComponentId),
      tx,
    )

    await repository.updateStructure(
      id,
      auth.organizationId,
      {
        name: input.name,
        code: input.code,
        description: input.description ?? null,
        salary_basis: input.salaryBasis,
        currency_code: input.currencyCode,
        is_active: input.isActive,
        pf_employee_rate: input.pfEmployeeRate,
        pf_employer_rate: input.pfEmployerRate,
        pf_wage_ceiling: input.pfWageCeiling,
        pf_eps_rate: input.pfEpsRate,
        esi_employee_rate: input.esiEmployeeRate,
        esi_employer_rate: input.esiEmployerRate,
        esi_wage_limit: input.esiWageLimit,
      },
      tx,
    )

    await repository.replaceStructureComponents(
      id,
      input.components.map((component, index) => ({
        salaryComponentId: component.salaryComponentId,
        calculationType: component.calculationType,
        amount: component.amount,
        percentage: component.percentage,
        displayOrder: component.displayOrder || index,
      })),
      tx,
    )

    return repository.findStructure(id, auth.organizationId, tx)
  })

  await recordAudit({
    ...context,
    action: 'SALARY_STRUCTURE_UPDATED',
    entityType: 'salary_structure',
    entityId: id,
    oldValues: { name: existing.name, components: existing.components.length },
    newValues: { name: input.name, components: input.components.length },
  })

  return structure ? presentStructure(structure) : null
}

// ---------------------------------------------------------------------------
// Employee salary assignments
// ---------------------------------------------------------------------------

export async function getSalaryHistory(auth: AuthContext, employeeId: string) {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.SALARY_VIEW_ALL,
    team: PERMISSIONS.SALARY_VIEW_TEAM,
    self: PERMISSIONS.SALARY_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const rows = await repository.listAssignments(employeeId)
  const assignments = rows.map(presentAssignment)

  // Attach the structure detail of the currently effective assignment so the
  // profile can show the breakdown without a second round trip.
  const today = new Date().toISOString().slice(0, 10) as IsoDate
  const current = await repository.findAssignmentForDate(employeeId, today)
  const structure = current ? await repository.findStructure(current.salary_structure_id, auth.organizationId) : null

  return {
    assignments,
    current: current ? presentAssignment(current) : null,
    currentStructure: structure ? presentStructure(structure) : null,
  }
}

/**
 * Assigns a salary from a date.
 *
 * The previous open assignment is closed the day before, so the history is a
 * continuous, non-overlapping timeline and old payroll keeps resolving to the
 * structure that was in force at the time (plan sections 21 and 32).
 */
export async function assignSalary(
  auth: AuthContext,
  employeeId: string,
  input: AssignSalaryInput,
  context: AuditContext,
) {
  await assertEmployeeInScope(auth, employeeId, 'ALL')

  const result = await withTransaction(async (tx) => {
    const structure = await repository.findStructure(input.salaryStructureId, auth.organizationId, tx)
    if (!structure) throw ApiError.badRequest('The selected salary structure does not exist')
    if (!structure.is_active) throw ApiError.businessRule('The selected salary structure is inactive')

    const open = await repository.findOpenAssignment(employeeId, tx)
    if (open) {
      if (input.effectiveFrom <= open.effective_from) {
        throw ApiError.businessRule(
          `A salary assignment already starts on ${open.effective_from}. The new one must start after that date.`,
        )
      }
      await repository.closeAssignment(open.id, addDays(input.effectiveFrom, -1), tx)
    }

    const assignment = await repository.insertAssignment(
      {
        organization_id: auth.organizationId,
        employee_id: employeeId,
        salary_structure_id: input.salaryStructureId,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        override_amount: input.overrideAmount ?? null,
        notes: input.notes ?? null,
        created_by: auth.userId,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: open ? 'SALARY_CHANGED' : 'SALARY_ASSIGNED',
        entityType: 'employee_salary_assignment',
        entityId: assignment.id,
        oldValues: open
          ? { structureId: open.salary_structure_id, effectiveFrom: open.effective_from, overrideAmount: open.override_amount }
          : undefined,
        newValues: {
          employeeId,
          structureId: input.salaryStructureId,
          effectiveFrom: input.effectiveFrom,
          overrideAmount: input.overrideAmount ?? null,
        },
      },
      tx,
    )

    return assignment
  })

  return presentAssignment(result)
}

