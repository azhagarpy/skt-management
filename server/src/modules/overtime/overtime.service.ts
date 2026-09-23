import { ApiError } from '../../utils/api-error.js'
import { withTransaction, type TxClient } from '../../database/tx.js'
import { pool, queryOne, type Queryable } from '../../database/pool.js'
import { addDays, datesBetween, startOfIsoWeek, type IsoDate } from '../../utils/dates.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause, type EmployeeScope } from '../employees/employee-access.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import * as calendarRepository from '../calendar/calendar.repository.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './overtime.repository.js'
import type { OvertimeListQuery, RecordOvertimeInput, UpdateOvertimeInput } from './overtime.validation.js'

/**
 * Overtime (README wishlist item 4).
 *
 * Supply employees never see OT as money: every 8 hours accumulated in a week
 * converts to one extra weekly off, capped at 2/week (16 hours). PSR employees
 * never see OT as days off: hours are paid at a per-hour rate in payroll
 * (payroll.service.ts). employee_type is what branches between the two - it is
 * never inferred from anything else.
 */

const SUPPLY_HOURS_PER_OFF = 8
const SUPPLY_MAX_OFFS_PER_WEEK = 2

export interface WeekConversionSummary {
  weekStart: IsoDate
  weekEnd: IsoDate
  totalHours: number
  extraOffsEarned: number
  offDates: IsoDate[]
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
  employee_type: string
  department_id: string | null
  location_id: string | null
}

async function loadEmployeeContext(employeeId: string, db: Queryable): Promise<EmployeeOvertimeContext> {
  const row = await queryOne<EmployeeOvertimeContext>(
    db,
    'SELECT id, employee_type, department_id, location_id FROM employees WHERE id = $1',
    [employeeId],
  )
  if (!row) throw ApiError.notFound('Employee')
  return row
}

function presentOvertime(row: repository.OvertimeRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    hours: Number(row.hours),
    remarks: row.remarks,
    isLocked: row.locked_by_payroll_run_id !== null,
    updatedAt: row.updated_at,
  }
}

function presentOvertimeWithEmployee(row: repository.OvertimeWithEmployeeRow) {
  return {
    ...presentOvertime(row),
    employeeCode: row.employee_code,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    departmentName: row.department_name,
  }
}

/**
 * Recomputes a Supply employee's extra-off entitlement for the week containing
 * `date`, and reconciles employee_extra_weekly_offs so it always matches -
 * recalculated from scratch on every change rather than incrementally, which is
 * what keeps it correct across edits and deletions alike.
 */
async function reconcileSupplyConversion(
  auth: AuthContext,
  employee: EmployeeOvertimeContext,
  date: IsoDate,
  tx: TxClient,
): Promise<WeekConversionSummary> {
  const weekStart = startOfIsoWeek(date)
  const weekEnd = addDays(weekStart, 6)
  const warnings: string[] = []

  const entries = await repository.listOvertimeForEmployee(employee.id, weekStart, weekEnd, tx)
  const totalHours = entries.reduce((sum, entry) => sum + Number(entry.hours), 0)

  const rawOffs = Math.floor(totalHours / SUPPLY_HOURS_PER_OFF)
  const extraOffsEarned = Math.min(rawOffs, SUPPLY_MAX_OFFS_PER_WEEK)

  if (totalHours % SUPPLY_HOURS_PER_OFF !== 0) {
    warnings.push(`${totalHours - rawOffs * SUPPLY_HOURS_PER_OFF} hour(s) this week are short of a full ${SUPPLY_HOURS_PER_OFF}-hour block and do not convert.`)
  }
  if (rawOffs > SUPPLY_MAX_OFFS_PER_WEEK) {
    warnings.push(`Overtime this week supports ${rawOffs} extra off(s), but only ${SUPPLY_MAX_OFFS_PER_WEEK} can be taken in one week.`)
  }

  const existingGrants = (
    await calendarRepository.listExtraWeeklyOffsInRange(auth.organizationId, weekStart, weekEnd, tx)
  )
    .filter((grant) => grant.employee_id === employee.id && grant.source === 'OVERTIME_CONVERSION')
    .sort((a, b) => (a.off_date < b.off_date ? -1 : 1))

  if (existingGrants.length > extraOffsEarned) {
    const excess = existingGrants.slice(extraOffsEarned)
    for (const grant of excess) {
      await calendarRepository.deleteExtraWeeklyOff(grant.id, auth.organizationId, tx)
    }
  } else if (existingGrants.length < extraOffsEarned) {
    const needed = extraOffsEarned - existingGrants.length
    const taken = new Set(existingGrants.map((grant) => grant.off_date))
    const calendar = await buildCalendarContext(auth.organizationId, weekStart, weekEnd, tx)
    const scope = { departmentId: employee.department_id, locationId: employee.location_id, employeeId: employee.id }

    const candidates = datesBetween(weekStart, weekEnd).filter((candidateDate) => {
      if (taken.has(candidateDate)) return false
      return calendar.dayFor(candidateDate, scope).kind === 'WORKING'
    })

    for (const candidateDate of candidates.slice(0, needed)) {
      await calendarRepository.insertExtraWeeklyOffs(
        auth.organizationId,
        [employee.id],
        candidateDate,
        'OVERTIME_CONVERSION',
        auth.userId,
        tx,
      )
    }
    if (candidates.length < needed) {
      warnings.push('Not every earned extra off could be placed on a working day this week; review the calendar manually.')
    }
  }

  const finalGrants = (
    await calendarRepository.listExtraWeeklyOffsInRange(auth.organizationId, weekStart, weekEnd, tx)
  ).filter((grant) => grant.employee_id === employee.id && grant.source === 'OVERTIME_CONVERSION')

  return {
    weekStart,
    weekEnd,
    totalHours,
    extraOffsEarned,
    offDates: finalGrants.map((grant) => grant.off_date).sort(),
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

    const row = await repository.upsertOvertime(
      {
        organizationId: auth.organizationId,
        employeeId: input.employeeId,
        workDate: input.workDate,
        hours: input.hours,
        remarks: input.remarks ?? null,
        userId: auth.userId,
      },
      tx,
    )

    let conversion: WeekConversionSummary | null = null
    if (employee.employee_type === 'SUPPLY') {
      conversion = await reconcileSupplyConversion(auth, employee, input.workDate, tx)
    }

    await recordAudit(
      {
        ...context,
        action: existing ? 'OVERTIME_CHANGED' : 'OVERTIME_RECORDED',
        entityType: 'overtime_entry',
        entityId: row.id,
        oldValues: existing ? { hours: Number(existing.hours) } : undefined,
        newValues: { employeeId: input.employeeId, date: input.workDate, hours: input.hours },
      },
      tx,
    )

    return { entry: presentOvertime(row), conversion }
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
    const row = await repository.upsertOvertime(
      {
        organizationId: auth.organizationId,
        employeeId: existing.employee_id,
        workDate: existing.work_date,
        hours: input.hours,
        remarks: input.remarks ?? existing.remarks,
        userId: auth.userId,
      },
      tx,
    )

    let conversion: WeekConversionSummary | null = null
    if (employee.employee_type === 'SUPPLY') {
      conversion = await reconcileSupplyConversion(auth, employee, existing.work_date, tx)
    }

    await recordAudit(
      {
        ...context,
        action: 'OVERTIME_CHANGED',
        entityType: 'overtime_entry',
        entityId: row.id,
        oldValues: { hours: Number(existing.hours) },
        newValues: { hours: input.hours },
      },
      tx,
    )

    return { entry: presentOvertime(row), conversion }
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

    let conversion: WeekConversionSummary | null = null
    if (employee.employee_type === 'SUPPLY') {
      conversion = await reconcileSupplyConversion(auth, employee, existing.work_date, tx)
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

    return { conversion }
  })
}

export async function listOvertime(auth: AuthContext, query: OvertimeListQuery) {
  if (query.to < query.from) throw ApiError.badRequest('The end date cannot be before the start date')
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)
  const rows = await repository.listOvertime(clause, query)
  return rows.map(presentOvertimeWithEmployee)
}

/** Read-only week summary, used by the entry screen's running "X/16 hrs" indicator. */
export async function getWeekSummary(auth: AuthContext, employeeId: string, date: IsoDate): Promise<WeekConversionSummary | null> {
  const scope = viewScope(auth)
  await assertEmployeeInScope(auth, employeeId, scope)

  const employee = await loadEmployeeContext(employeeId, pool)
  if (employee.employee_type !== 'SUPPLY') return null

  const weekStart = startOfIsoWeek(date)
  const weekEnd = addDays(weekStart, 6)
  const entries = await repository.listOvertimeForEmployee(employeeId, weekStart, weekEnd)
  const totalHours = entries.reduce((sum, entry) => sum + Number(entry.hours), 0)
  const rawOffs = Math.floor(totalHours / SUPPLY_HOURS_PER_OFF)
  const extraOffsEarned = Math.min(rawOffs, SUPPLY_MAX_OFFS_PER_WEEK)

  const grants = (await calendarRepository.listExtraWeeklyOffsInRange(auth.organizationId, weekStart, weekEnd)).filter(
    (grant) => grant.employee_id === employeeId && grant.source === 'OVERTIME_CONVERSION',
  )

  return {
    weekStart,
    weekEnd,
    totalHours,
    extraOffsEarned,
    offDates: grants.map((grant) => grant.off_date).sort(),
    warnings: [],
  }
}
