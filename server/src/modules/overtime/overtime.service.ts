import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { pool, queryOne, type Queryable } from '../../database/pool.js'
import {
  addDays,
  countDaysBetween,
  payCycleContaining,
  PAYROLL_CYCLE_CUTOFF_DAY,
  startOfIsoWeek,
  type IsoDate,
} from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { overtimeDaySalaryMinor } from '../payroll/payroll.calculator.js'
import { toComponentInputs } from '../payroll/payroll.service.js'
import * as salaryRepository from '../salary/salary.repository.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause, type EmployeeScope } from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './overtime.repository.js'
import {
  assertPaidOffsStillEarned,
  HOURS_PER_PAID_OFF,
  loadOvertimeRemovalCheck,
  loadPaidOffBalances,
  MAX_PAID_OFFS_PER_WEEK,
  paidOffsForWeek,
  type PaidOffBalance,
} from './paid-offs.js'
import type { OvertimeListQuery, RecordOvertimeInput, UpdateOvertimeInput } from './overtime.validation.js'

/**
 * Overtime (README wishlist item 4).
 *
 * Supply employees never see OT as money: every 8 hours in a week earns one
 * paid off, up to 2 a week - a paid day off on a date chosen for it
 * (paid-offs.ts). PSR employees never see OT as days off: hours are paid in
 * payroll (payroll.service.ts) at the rate chosen on each entry - one day's
 * salary / n hours, or a custom amount per hour. The employee's type carries
 * which of the two applies as `overtime_handling`, so a type added later has to
 * declare its behaviour rather than falling through both branches.
 */

/** The n in "one day's salary / n" when an entry does not choose its own. */
const DEFAULT_DAY_DIVISOR = 8

/** A Supply employee's week of overtime, the paid offs it earns, and their paid-off balance. */
export interface PaidOffWeekSummary {
  weekStart: IsoDate
  weekEnd: IsoDate
  totalHours: number
  /** Paid offs this week's hours earn. */
  paidOffsEarned: number
  /** Over every week: earned, given a date, and still to be given one. */
  balance: { earned: number; scheduled: number; available: number }
  warnings: string[]
}

function viewScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.OVERTIME_VIEW_ALL,
    team: PERMISSIONS.OVERTIME_VIEW_TEAM,
    self: PERMISSIONS.OVERTIME_VIEW_SELF,
  })
}

function manageScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.OVERTIME_MANAGE_ALL,
    team: PERMISSIONS.OVERTIME_MANAGE_TEAM,
  })
}

interface EmployeeOvertimeContext {
  id: string
  overtime_handling: string
  overtime_rate_override_minor: number | null
  department_id: string | null
  location_id: string | null
}

async function loadEmployeeContext(employeeId: string, db: Queryable): Promise<EmployeeOvertimeContext> {
  const row = await queryOne<EmployeeOvertimeContext>(
    db,
    `SELECT e.id, t.overtime_handling, e.overtime_rate_override_minor, e.department_id, e.location_id
       FROM employees e
       JOIN employee_types t ON t.id = e.employee_type_id
      WHERE e.id = $1`,
    [employeeId],
  )
  if (!row) throw ApiError.notFound('Employee')
  return row
}

/** The employee's own rate when their record has one, else one day's salary / 8. */
function defaultRate(employee: EmployeeOvertimeContext): repository.OvertimeRate {
  return employee.overtime_rate_override_minor === null
    ? { basis: 'DAY_SALARY', dayDivisor: DEFAULT_DAY_DIVISOR, ratePerHourMinor: null }
    : { basis: 'CUSTOM', dayDivisor: null, ratePerHourMinor: employee.overtime_rate_override_minor }
}

function rowRate(row: repository.OvertimeRow): repository.OvertimeRate {
  return {
    basis: row.rate_basis,
    dayDivisor: row.day_divisor === null ? null : Number(row.day_divisor),
    ratePerHourMinor: row.rate_per_hour_minor,
  }
}

/**
 * The rate an entry is saved at: the one the form chose, else the entry's
 * current rate when it already exists, else the employee's default.
 */
function resolveRate(
  input: Pick<RecordOvertimeInput, 'rateBasis' | 'dayDivisor' | 'ratePerHour'>,
  existing: repository.OvertimeRow | null,
  employee: EmployeeOvertimeContext,
): repository.OvertimeRate {
  if (input.rateBasis === 'CUSTOM') {
    return { basis: 'CUSTOM', dayDivisor: null, ratePerHourMinor: toMinor(input.ratePerHour ?? 0) }
  }
  if (input.rateBasis === 'DAY_SALARY') {
    return { basis: 'DAY_SALARY', dayDivisor: input.dayDivisor ?? DEFAULT_DAY_DIVISOR, ratePerHourMinor: null }
  }
  return existing ? rowRate(existing) : defaultRate(employee)
}

function presentRate(rate: repository.OvertimeRate) {
  return {
    rateBasis: rate.basis,
    dayDivisor: rate.dayDivisor,
    ratePerHour: rate.ratePerHourMinor === null ? null : toMajor(rate.ratePerHourMinor),
  }
}

function presentOvertime(row: repository.OvertimeRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    hours: Number(row.hours),
    remarks: row.remarks,
    ...presentRate(rowRate(row)),
    isLocked: row.locked_by_payroll_run_id !== null,
    updatedAt: row.updated_at,
  }
}

function presentOvertimeWithEmployee(row: repository.OvertimeWithEmployeeRow, paidOffScheduled: boolean) {
  return {
    ...presentOvertime(row),
    employeeCode: row.employee_code,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    departmentName: row.department_name,
    overtimeHandling: row.overtime_handling,
    /** Supply overtime whose paid off has been given a date: it can no longer be deleted. */
    paidOffScheduled,
  }
}

/** The week containing `date` for a Supply employee, with their paid-off balance. */
async function supplyWeekSummary(employeeId: string, date: IsoDate, db: Queryable): Promise<PaidOffWeekSummary> {
  const weekStart = startOfIsoWeek(date)
  const weekEnd = addDays(weekStart, 6)
  const entries = await repository.listOvertimeForEmployee(employeeId, weekStart, weekEnd, db)
  const totalHours = entries.reduce((sum, entry) => sum + Number(entry.hours), 0)

  const warnings: string[] = []
  const fullBlocks = Math.floor(totalHours / HOURS_PER_PAID_OFF)
  if (totalHours % HOURS_PER_PAID_OFF !== 0) {
    warnings.push(
      `${totalHours - fullBlocks * HOURS_PER_PAID_OFF} hour(s) this week are short of a full ${HOURS_PER_PAID_OFF}-hour block and earn no paid off.`,
    )
  }
  if (fullBlocks > MAX_PAID_OFFS_PER_WEEK) {
    warnings.push(`This week's overtime comes to ${fullBlocks} paid offs, but at most ${MAX_PAID_OFFS_PER_WEEK} can be earned in one week.`)
  }

  const balance = (await loadPaidOffBalances([employeeId], db)).get(employeeId) as PaidOffBalance
  return {
    weekStart,
    weekEnd,
    totalHours,
    paidOffsEarned: paidOffsForWeek(totalHours),
    balance: { earned: balance.earned, scheduled: balance.scheduled.length, available: balance.available },
    warnings,
  }
}

async function assertNotPayrollLocked(employeeId: string, date: IsoDate, db: Queryable): Promise<repository.OvertimeRow | null> {
  const existing = await repository.findOvertimeForDate(employeeId, date, db)
  if (existing?.locked_by_payroll_run_id) {
    throw ApiError.businessRule(
      'This overtime date is part of a locked payroll run and can no longer be edited. Raise a payroll adjustment instead.',
    )
  }
  return existing
}

export async function recordOvertime(auth: AuthContext, input: RecordOvertimeInput, context: AuditContext) {
  const scope = manageScope(auth)

  return withTransaction(async (tx) => {
    await assertEmployeeInScope(auth, input.employeeId, scope, tx)
    const employee = await loadEmployeeContext(input.employeeId, tx)
    const existing = await assertNotPayrollLocked(input.employeeId, input.workDate, tx)
    const rate = resolveRate(input, existing, employee)

    const row = await repository.upsertOvertime(
      {
        organizationId: auth.organizationId,
        employeeId: input.employeeId,
        workDate: input.workDate,
        hours: input.hours,
        remarks: input.remarks ?? null,
        rate,
        userId: auth.userId,
      },
      tx,
    )

    // Less overtime can leave scheduled paid offs unearned; that undoes the change.
    let paidOffs: PaidOffWeekSummary | null = null
    if (employee.overtime_handling === 'OFF_IN_LIEU') {
      await assertPaidOffsStillEarned(employee.id, tx)
      paidOffs = await supplyWeekSummary(employee.id, input.workDate, tx)
    }

    await recordAudit(
      {
        ...context,
        action: existing ? 'OVERTIME_CHANGED' : 'OVERTIME_RECORDED',
        entityType: 'overtime_entry',
        entityId: row.id,
        oldValues: existing ? { hours: Number(existing.hours), ...presentRate(rowRate(existing)) } : undefined,
        newValues: { employeeId: input.employeeId, date: input.workDate, hours: input.hours, ...presentRate(rate) },
      },
      tx,
    )

    return { entry: presentOvertime(row), paidOffs }
  })
}

export async function updateOvertime(
  auth: AuthContext,
  id: string,
  input: UpdateOvertimeInput,
  context: AuditContext,
) {
  const scope = manageScope(auth)

  return withTransaction(async (tx) => {
    const existing = await repository.findOvertimeById(id, auth.organizationId, tx)
    if (!existing) throw ApiError.notFound('Overtime entry')
    await assertEmployeeInScope(auth, existing.employee_id, scope, tx)
    if (existing.locked_by_payroll_run_id) {
      throw ApiError.businessRule(
        'This overtime date is part of a locked payroll run and can no longer be edited. Raise a payroll adjustment instead.',
      )
    }

    const employee = await loadEmployeeContext(existing.employee_id, tx)
    const rate = resolveRate(input, existing, employee)
    const row = await repository.upsertOvertime(
      {
        organizationId: auth.organizationId,
        employeeId: existing.employee_id,
        workDate: existing.work_date,
        hours: input.hours,
        remarks: input.remarks ?? existing.remarks,
        rate,
        userId: auth.userId,
      },
      tx,
    )

    let paidOffs: PaidOffWeekSummary | null = null
    if (employee.overtime_handling === 'OFF_IN_LIEU') {
      await assertPaidOffsStillEarned(employee.id, tx)
      paidOffs = await supplyWeekSummary(employee.id, existing.work_date, tx)
    }

    await recordAudit(
      {
        ...context,
        action: 'OVERTIME_CHANGED',
        entityType: 'overtime_entry',
        entityId: row.id,
        oldValues: { hours: Number(existing.hours), ...presentRate(rowRate(existing)) },
        newValues: { hours: input.hours, ...presentRate(rate) },
      },
      tx,
    )

    return { entry: presentOvertime(row), paidOffs }
  })
}

export async function deleteOvertime(auth: AuthContext, id: string, context: AuditContext) {
  const scope = manageScope(auth)

  return withTransaction(async (tx) => {
    const existing = await repository.findOvertimeById(id, auth.organizationId, tx)
    if (!existing) throw ApiError.notFound('Overtime entry')
    await assertEmployeeInScope(auth, existing.employee_id, scope, tx)
    if (existing.locked_by_payroll_run_id) {
      throw ApiError.businessRule(
        'This overtime date is part of a locked payroll run and can no longer be edited. Raise a payroll adjustment instead.',
      )
    }

    const employee = await loadEmployeeContext(existing.employee_id, tx)
    await repository.deleteOvertime(id, auth.organizationId, tx)

    let paidOffs: PaidOffWeekSummary | null = null
    if (employee.overtime_handling === 'OFF_IN_LIEU') {
      await assertPaidOffsStillEarned(employee.id, tx)
      paidOffs = await supplyWeekSummary(employee.id, existing.work_date, tx)
    }

    await recordAudit(
      {
        ...context,
        action: 'OVERTIME_CHANGED',
        entityType: 'overtime_entry',
        entityId: id,
        oldValues: { hours: Number(existing.hours), date: existing.work_date },
      },
      tx,
    )

    return { paidOffs }
  })
}

export async function listOvertime(auth: AuthContext, query: OvertimeListQuery) {
  if (query.to < query.from) throw ApiError.badRequest('The end date cannot be before the start date')
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)
  const rows = await repository.listOvertime(clause, query)
  const supplyIds = [...new Set(rows.filter((row) => row.overtime_handling === 'OFF_IN_LIEU').map((row) => row.employee_id))]
  const removalBlocked = await loadOvertimeRemovalCheck(supplyIds)
  return rows.map((row) =>
    presentOvertimeWithEmployee(
      row,
      row.overtime_handling === 'OFF_IN_LIEU' && removalBlocked(row.employee_id, row.work_date, Number(row.hours)),
    ),
  )
}

/**
 * One day's salary for the pay cycle containing `date`, worked out the way
 * payroll does, so the entry screen can show what "one day's salary / n" comes
 * to. Null when no salary structure is assigned for that cycle.
 */
async function daySalaryOn(organizationId: string, employeeId: string, date: IsoDate): Promise<number | null> {
  const cycle = payCycleContaining(date, PAYROLL_CYCLE_CUTOFF_DAY)
  const [assignment] = await salaryRepository.findAssignmentsForDate([employeeId], cycle.end)
  if (!assignment) return null
  const structure = await salaryRepository.findStructure(assignment.salary_structure_id, organizationId)
  if (!structure) return null
  return toMajor(
    overtimeDaySalaryMinor(
      toComponentInputs(structure),
      assignment.override_amount === null ? null : toMinor(assignment.override_amount),
      structure.salary_basis,
      countDaysBetween(cycle.start, cycle.end),
    ),
  )
}

/**
 * How an employee's overtime is handled, the rate a new entry starts at, and
 * one day's salary on `date`, so the entry screen can offer the rate inputs
 * only to a paid-hourly employee, fill them in with that employee's default,
 * and show what the entry will be paid.
 */
export async function getEmployeeOvertimeSettings(auth: AuthContext, employeeId: string, date: IsoDate) {
  await assertEmployeeInScope(auth, employeeId, viewScope(auth))
  const employee = await loadEmployeeContext(employeeId, pool)
  return {
    overtimeHandling: employee.overtime_handling,
    ...presentRate(defaultRate(employee)),
    daySalary: employee.overtime_handling === 'PAID_HOURLY' ? await daySalaryOn(auth.organizationId, employeeId, date) : null,
  }
}

/** Read-only week summary, for the entry screen's running hours and paid-offs indicator. */
export async function getWeekSummary(auth: AuthContext, employeeId: string, date: IsoDate): Promise<PaidOffWeekSummary | null> {
  await assertEmployeeInScope(auth, employeeId, viewScope(auth))
  const employee = await loadEmployeeContext(employeeId, pool)
  if (employee.overtime_handling !== 'OFF_IN_LIEU') return null
  return supplyWeekSummary(employeeId, date, pool)
}
