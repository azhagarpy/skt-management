import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { todayIso, type IsoDate } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import {
  assertCanManageEmployees,
  assertEmployeeInScope,
  resolveScope,
  scopeClause,
} from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './salary.repository.js'
import { planAssignment } from './assignment-plan.js'
import { periodInForce, withEffectiveTo } from './statutory-rates.js'
import type {
  AssignSalaryInput,
  BulkAssignSalaryInput,
  SalaryComponentInput,
  SalaryStructureInput,
  StatutoryRateInput,
  UpdateSalaryStructureInput,
} from './salary.validation.js'

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export function presentComponent(row: repository.SalaryComponentRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    isActive: row.is_active,
    holidayExtraPay: row.holiday_extra_pay,
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

export function presentStatutoryRate(row: repository.StatutoryRateRow, effectiveTo: IsoDate | null) {
  return {
    id: row.id,
    /** Null for the first period, which covers every date before the next one. */
    effectiveFrom: row.effective_from,
    /** The last day in force; null while no later period has started. */
    effectiveTo,
    pfEmployeeRate: Number(row.pf_employee_rate),
    pfEmployerRate: Number(row.pf_employer_rate),
    pfWageCeiling: Number(row.pf_wage_ceiling),
    pfEpsRate: Number(row.pf_eps_rate),
    esiEmployeeRate: Number(row.esi_employee_rate),
    esiEmployerRate: Number(row.esi_employer_rate),
    esiWageLimit: Number(row.esi_wage_limit),
  }
}

export function presentStructure(row: repository.SalaryStructureWithComponents) {
  const statutoryRates = withEffectiveTo(row.statutory_rates).map(({ period, effectiveTo }) =>
    presentStatutoryRate(period, effectiveTo),
  )
  const current = periodInForce(row.statutory_rates, todayIso())
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    salaryBasis: row.salary_basis,
    currencyCode: row.currency_code,
    isActive: row.is_active,
    /** PF and ESI periods, oldest first. */
    statutoryRates,
    /** The PF and ESI period in force today. */
    currentStatutoryRate: statutoryRates.find((rate) => rate.id === current?.id) ?? null,
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
      holidayExtraPay: component.holiday_extra_pay,
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
// the only choices left to the admin are its name, code, active flag and
// whether it is part of holiday work pay (plan: simplified salary module).
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
    holiday_extra_pay: input.holidayExtraPay,
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
    holiday_extra_pay: input.holidayExtraPay,
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
        created_by: auth.userId,
      },
      tx,
    )

    // The first period has no start date, so the structure has PF and ESI
    // rates for any date until a dated change is added.
    await repository.insertStatutoryRate(
      { salary_structure_id: created.id, ...statutoryRateValues({ ...input, effectiveFrom: null }), created_by: auth.userId },
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
  input: UpdateSalaryStructureInput,
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
// PF and ESI rate periods
// ---------------------------------------------------------------------------

function statutoryRateValues(input: StatutoryRateInput) {
  return {
    effective_from: input.effectiveFrom,
    pf_employee_rate: input.pfEmployeeRate,
    pf_employer_rate: input.pfEmployerRate,
    pf_wage_ceiling: input.pfWageCeiling,
    pf_eps_rate: input.pfEpsRate,
    esi_employee_rate: input.esiEmployeeRate,
    esi_employer_rate: input.esiEmployerRate,
    esi_wage_limit: input.esiWageLimit,
  }
}

async function findStructureOrThrow(auth: AuthContext, structureId: string, db?: Parameters<typeof repository.findStructure>[2]) {
  const structure = await repository.findStructure(structureId, auth.organizationId, db)
  if (!structure) throw ApiError.notFound('Salary structure')
  return structure
}

/** No two periods of a structure may start on the same date. */
async function assertStartIsFree(
  structureId: string,
  effectiveFrom: IsoDate,
  exceptRateId: string | null,
  db: Parameters<typeof repository.findStatutoryRateStarting>[2],
): Promise<void> {
  const clash = await repository.findStatutoryRateStarting(structureId, effectiveFrom, db)
  if (clash && clash.id !== exceptRateId) {
    throw ApiError.businessRule(
      `PF and ESI rates already change on ${effectiveFrom}. Edit that period instead, or pick another date.`,
    )
  }
}

/**
 * Starts a new PF and ESI period from a date. The period before it now ends
 * the day before; payroll for any run ending on or after the date uses the new
 * rates once it is calculated. Approved runs keep the rates they were
 * calculated with.
 */
export async function addStatutoryRate(
  auth: AuthContext,
  structureId: string,
  input: StatutoryRateInput,
  context: AuditContext,
) {
  const effectiveFrom = input.effectiveFrom
  if (!effectiveFrom) throw ApiError.badRequest('Choose the date the new rates start from')

  const structure = await withTransaction(async (tx) => {
    await findStructureOrThrow(auth, structureId, tx)
    await assertStartIsFree(structureId, effectiveFrom, null, tx)
    const created = await repository.insertStatutoryRate(
      { salary_structure_id: structureId, ...statutoryRateValues(input), created_by: auth.userId },
      tx,
    )
    await recordAudit(
      {
        ...context,
        action: 'STATUTORY_CONFIG_UPDATED',
        entityType: 'salary_structure_statutory_rate',
        entityId: created.id,
        newValues: { structureId, ...presentStatutoryRate(created, null) },
      },
      tx,
    )
    return findStructureOrThrow(auth, structureId, tx)
  })

  return presentStructure(structure)
}

/**
 * Changes a period's rates, and for a dated period its start date. The first
 * period always covers everything before the next one, so it keeps no date.
 */
export async function updateStatutoryRate(
  auth: AuthContext,
  structureId: string,
  rateId: string,
  input: StatutoryRateInput,
  context: AuditContext,
) {
  const structure = await withTransaction(async (tx) => {
    await findStructureOrThrow(auth, structureId, tx)
    const existing = await repository.findStatutoryRate(rateId, structureId, tx)
    if (!existing) throw ApiError.notFound('PF and ESI rate period')

    if (existing.effective_from === null && input.effectiveFrom !== null) {
      throw ApiError.businessRule(
        'The first period covers every date before the next change, so it has no start date. Add a new period to change the rates from a date.',
      )
    }
    if (existing.effective_from !== null) {
      if (!input.effectiveFrom) throw ApiError.badRequest('Choose the date these rates start from')
      await assertStartIsFree(structureId, input.effectiveFrom, rateId, tx)
    }

    const updated = await repository.updateStatutoryRate(rateId, structureId, statutoryRateValues(input), tx)
    if (!updated) throw ApiError.notFound('PF and ESI rate period')

    await recordAudit(
      {
        ...context,
        action: 'STATUTORY_CONFIG_UPDATED',
        entityType: 'salary_structure_statutory_rate',
        entityId: rateId,
        oldValues: { structureId, ...presentStatutoryRate(existing, null) },
        newValues: { structureId, ...presentStatutoryRate(updated, null) },
      },
      tx,
    )
    return findStructureOrThrow(auth, structureId, tx)
  })

  return presentStructure(structure)
}

/** Removes a dated period; the one before it runs on in its place. */
export async function deleteStatutoryRate(auth: AuthContext, structureId: string, rateId: string, context: AuditContext) {
  const structure = await withTransaction(async (tx) => {
    await findStructureOrThrow(auth, structureId, tx)
    const existing = await repository.findStatutoryRate(rateId, structureId, tx)
    if (!existing) throw ApiError.notFound('PF and ESI rate period')
    if (existing.effective_from === null) {
      throw ApiError.businessRule('The first period cannot be removed: a structure always needs PF and ESI rates.')
    }

    await repository.deleteStatutoryRate(rateId, structureId, tx)

    await recordAudit(
      {
        ...context,
        action: 'STATUTORY_CONFIG_UPDATED',
        entityType: 'salary_structure_statutory_rate',
        entityId: rateId,
        oldValues: { structureId, ...presentStatutoryRate(existing, null) },
      },
      tx,
    )
    return findStructureOrThrow(auth, structureId, tx)
  })

  return presentStructure(structure)
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

// ---------------------------------------------------------------------------
// Assigning salaries
//
// An employee's assignments form a timeline. A new one can start on any date:
// on the start date of an existing one it changes that one; inside one it
// splits it; anywhere else it runs until the next one starts (assignment-plan.ts).
// The same change can be made for many employees at once, and is previewed
// first so the admin can confirm exactly what changes.
// ---------------------------------------------------------------------------

export type AssignmentAction = 'NEW' | 'REPLACE' | 'SPLIT' | 'UNCHANGED'

function fullName(row: { first_name: string; middle_name: string | null; last_name: string | null }): string {
  return [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')
}

function amountOrNull(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export function presentEmployeeAssignment(row: repository.EmployeeAssignmentRow) {
  return {
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: fullName(row),
    employmentStatus: row.employment_status,
    departmentId: row.department_id,
    departmentName: row.department_name,
    designationName: row.designation_name,
    /** The assignment in force on the date asked about; null when there is none. */
    assignment: row.assignment_id
      ? {
          id: row.assignment_id,
          salaryStructureId: row.salary_structure_id,
          structureName: row.structure_name,
          salaryBasis: row.salary_basis,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to,
          overrideAmount: amountOrNull(row.override_amount),
        }
      : null,
  }
}

function assignScope(auth: AuthContext) {
  return resolveScope(auth, { all: PERMISSIONS.SALARY_MANAGE, team: PERMISSIONS.SALARY_MANAGE_TEAM })
}

/** Everyone the caller may assign a salary to, with the structure each has on a date. */
export async function listEmployeeAssignments(auth: AuthContext, onDate: IsoDate) {
  const scope = assignScope(auth)
  const rows = await repository.listEmployeeAssignmentsOn((start) => scopeClause(auth, scope, 'e', start), onDate)
  // A supervisor cannot change their own salary, so they are not offered it.
  return rows
    .filter((row) => scope !== 'TEAM' || row.employee_id !== auth.employeeId)
    .map(presentEmployeeAssignment)
}

async function assignableStructure(
  auth: AuthContext,
  structureId: string,
  db?: Parameters<typeof repository.findStructure>[2],
) {
  const structure = await repository.findStructure(structureId, auth.organizationId, db)
  if (!structure) throw ApiError.badRequest('The selected salary structure does not exist')
  if (!structure.is_active) throw ApiError.businessRule('The selected salary structure is inactive')
  return structure
}

/**
 * What assigning does to one employee's timeline. Assigning the structure and
 * amount the employee already has on that date changes nothing, so it is left
 * alone rather than splitting a period into two identical ones.
 */
function planFor(timeline: repository.SalaryAssignmentRow[], input: BulkAssignSalaryInput) {
  const plan = planAssignment(timeline, input.effectiveFrom)
  const unchanged =
    plan.target !== null &&
    plan.target.salary_structure_id === input.salaryStructureId &&
    amountOrNull(plan.target.override_amount) === amountOrNull(input.overrideAmount)
  return { plan, action: (unchanged ? 'UNCHANGED' : plan.kind) as AssignmentAction }
}

function byEmployee(rows: repository.SalaryAssignmentRow[]): Map<string, repository.SalaryAssignmentRow[]> {
  const map = new Map<string, repository.SalaryAssignmentRow[]>()
  for (const row of rows) map.set(row.employee_id, [...(map.get(row.employee_id) ?? []), row])
  return map
}

const APPROVED_RUN_STATUSES = new Set(['APPROVED', 'LOCKED'])

/**
 * Shows, before anything is saved, what assigning a structure from a date
 * does to each selected employee, and which payroll runs it reaches: payroll
 * uses the assignment in force on a run's last day, so a run is reached when
 * that day falls in the new period. Approved runs keep their figures; the
 * others take the change when they are calculated.
 */
export async function previewAssignment(auth: AuthContext, input: BulkAssignSalaryInput) {
  const scope = assignScope(auth)
  const employeeIds = [...new Set(input.employeeIds)]
  await assertCanManageEmployees(auth, employeeIds, scope)
  const structure = await assignableStructure(auth, input.salaryStructureId)

  const [timelines, employees, runs] = await Promise.all([
    repository.listActiveAssignments(employeeIds).then(byEmployee),
    repository.listEmployeeAssignmentsOn((start) => scopeClause(auth, scope, 'e', start), input.effectiveFrom),
    repository.listRunsEndingFrom(auth.organizationId, input.effectiveFrom),
  ])
  const employeeById = new Map(employees.map((employee) => [employee.employee_id, employee]))

  const reached = new Map<string, repository.PayrollRunReach>()
  const rows = employeeIds.map((employeeId) => {
    const employee = employeeById.get(employeeId)
    const { plan, action } = planFor(timelines.get(employeeId) ?? [], input)
    if (action !== 'UNCHANGED') {
      for (const run of runs) {
        if (plan.effectiveTo === null || run.period_end <= plan.effectiveTo) reached.set(`${run.year}-${run.month}`, run)
      }
    }
    return {
      employeeId,
      employeeCode: employee?.employee_code ?? '',
      employeeName: employee ? fullName(employee) : '',
      action,
      effectiveTo: plan.effectiveTo,
      /** The assignment this one changes or splits; null when it starts a new period. */
      current: plan.target
        ? {
            structureName: plan.target.structure_name ?? null,
            effectiveFrom: plan.target.effective_from,
            effectiveTo: plan.target.effective_to,
            overrideAmount: amountOrNull(plan.target.override_amount),
          }
        : null,
      /** For a split: the day the current assignment now ends. */
      currentEndsOn: plan.kind === 'SPLIT' && action !== 'UNCHANGED' ? plan.targetEndsOn : null,
    }
  })

  const reachedRuns = [...reached.values()].map((run) => ({ year: run.year, month: run.month, status: run.status }))
  return {
    structure: { id: structure.id, name: structure.name, salaryBasis: structure.salary_basis },
    effectiveFrom: input.effectiveFrom,
    overrideAmount: amountOrNull(input.overrideAmount),
    employees: rows,
    payroll: {
      /** Not yet approved: they use the new structure once calculated again. */
      toRecalculate: reachedRuns.filter((run) => !APPROVED_RUN_STATUSES.has(run.status)),
      /** Approved or locked: they keep the figures they were approved with. */
      approved: reachedRuns.filter((run) => APPROVED_RUN_STATUSES.has(run.status)),
    },
  }
}

/** Assigns one structure, from one date, to every selected employee, in one transaction. */
export async function assignSalaries(auth: AuthContext, input: BulkAssignSalaryInput, context: AuditContext) {
  const scope = assignScope(auth)
  const employeeIds = [...new Set(input.employeeIds)]
  await assertCanManageEmployees(auth, employeeIds, scope)

  const results = await withTransaction(async (tx) => {
    await assignableStructure(auth, input.salaryStructureId, tx)
    const timelines = byEmployee(await repository.listActiveAssignments(employeeIds, tx, true))

    const done: { employeeId: string; action: AssignmentAction; assignment: repository.SalaryAssignmentRow }[] = []
    for (const employeeId of employeeIds) {
      const { plan, action } = planFor(timelines.get(employeeId) ?? [], input)
      if (action === 'UNCHANGED' && plan.target) {
        done.push({ employeeId, action, assignment: plan.target })
        continue
      }

      let assignment: repository.SalaryAssignmentRow | null
      if (plan.kind === 'REPLACE') {
        assignment = await repository.updateAssignment(
          plan.target.id,
          {
            salary_structure_id: input.salaryStructureId,
            override_amount: input.overrideAmount ?? null,
            notes: input.notes ?? plan.target.notes,
          },
          tx,
        )
      } else {
        // Shorten the split assignment before inserting, so the two never overlap.
        if (plan.kind === 'SPLIT') {
          await repository.updateAssignment(plan.target.id, { effective_to: plan.targetEndsOn }, tx)
        }
        assignment = await repository.insertAssignment(
          {
            organization_id: auth.organizationId,
            employee_id: employeeId,
            salary_structure_id: input.salaryStructureId,
            effective_from: input.effectiveFrom,
            effective_to: plan.effectiveTo,
            override_amount: input.overrideAmount ?? null,
            notes: input.notes ?? null,
            created_by: auth.userId,
          },
          tx,
        )
      }
      if (!assignment) throw ApiError.notFound('Salary assignment')

      await recordAudit(
        {
          ...context,
          action: plan.target ? 'SALARY_CHANGED' : 'SALARY_ASSIGNED',
          entityType: 'employee_salary_assignment',
          entityId: assignment.id,
          oldValues: plan.target
            ? {
                structureId: plan.target.salary_structure_id,
                effectiveFrom: plan.target.effective_from,
                effectiveTo: plan.target.effective_to,
                overrideAmount: plan.target.override_amount,
              }
            : undefined,
          newValues: {
            employeeId,
            change: plan.kind,
            structureId: input.salaryStructureId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: plan.effectiveTo,
            overrideAmount: input.overrideAmount ?? null,
            ...(plan.kind === 'SPLIT' ? { previousEndsOn: plan.targetEndsOn } : {}),
          },
        },
        tx,
      )
      done.push({ employeeId, action, assignment })
    }
    return done
  })

  return {
    assigned: results.filter((result) => result.action !== 'UNCHANGED').length,
    unchanged: results.filter((result) => result.action === 'UNCHANGED').length,
    results: results.map((result) => ({
      employeeId: result.employeeId,
      action: result.action,
      assignment: presentAssignment(result.assignment),
    })),
  }
}

/** Assigns a salary to one employee from a date: the one-employee form of assignSalaries. */
export async function assignSalary(
  auth: AuthContext,
  employeeId: string,
  input: AssignSalaryInput,
  context: AuditContext,
) {
  const { results } = await assignSalaries(auth, { ...input, employeeIds: [employeeId] }, context)
  const [result] = results
  if (!result) throw ApiError.notFound('Salary assignment')
  return result.assignment
}
