import { ApiError } from '../../utils/api-error.js'
import { withTransaction, type TxClient } from '../../database/tx.js'
import { pool, queryOne, type Queryable } from '../../database/pool.js'
import {
  datesBetween,
  monthLabel,
  payCycleFor,
  PAYROLL_CYCLE_CUTOFF_DAY,
  type IsoDate,
} from '../../utils/dates.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause, type EmployeeScope } from '../employees/employee-access.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './attendance.repository.js'
import { checkAbsenceStreaks } from './absence-alert.js'
import type {
  AttendanceListQuery,
  BulkMarkAttendanceInput,
  DailySheetQuery,
  MarkAttendanceInput,
  MonthlyQuery,
  UpdateAttendanceInput,
} from './attendance.validation.js'

/** Short codes used by the monthly calendar view (plan section 7). */
export const STATUS_CODES: Record<string, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  ON_LEAVE: 'L',
  HALF_DAY_LEAVE: 'HL',
  HOLIDAY: 'H',
  WEEKLY_OFF: 'WO',
}

function viewScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.ATTENDANCE_VIEW_ALL,
    team: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
    self: PERMISSIONS.ATTENDANCE_VIEW_SELF,
  })
}

function manageScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.ATTENDANCE_MANAGE_ALL,
    team: PERMISSIONS.ATTENDANCE_MANAGE_TEAM,
  })
}

/**
 * Refuses edits to a date already consumed by an approved or locked payroll run
 * (plan section 33). Corrections go through a payroll adjustment instead.
 */
async function assertNotPayrollLocked(
  employeeId: string,
  date: IsoDate,
  db: Queryable,
): Promise<repository.AttendanceRow | null> {
  const existing = await repository.findAttendanceForDate(employeeId, date, db)
  if (existing?.locked_by_payroll_run_id) {
    throw ApiError.businessRule(
      'This attendance date is part of a locked payroll run and can no longer be edited. Raise a payroll adjustment instead.',
    )
  }
  return existing
}

function presentAttendance(row: repository.AttendanceWithEmployeeRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    departmentName: row.department_name,
    attendanceDate: row.attendance_date,
    status: row.status,
    statusCode: STATUS_CODES[row.status] ?? row.status,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name,
    leaveRequestId: row.leave_request_id,
    source: row.source,
    shiftId: row.shift_id,
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    remarks: row.remarks,
    isLocked: row.locked_by_payroll_run_id !== null,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The daily marking sheet: every in-scope employee for one date, with the
 * calendar's opinion of that day so the UI can pre-select Holiday/Weekly Off.
 */
export async function getDailySheet(auth: AuthContext, query: DailySheetQuery) {
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)

  const [rows, calendar] = await Promise.all([
    repository.dailySheet(clause, query.date, query),
    buildCalendarContext(auth.organizationId, query.date, query.date),
  ])

  const canManage = auth.hasAny(PERMISSIONS.ATTENDANCE_MANAGE_ALL, PERMISSIONS.ATTENDANCE_MANAGE_TEAM)

  const items = rows.map((row) => {
    const day = calendar.dayFor(query.date, {
      departmentId: row.department_id,
      locationId: row.location_id,
      employeeId: row.employee_id,
    })
    return {
      employeeId: row.employee_id,
      employeeCode: row.employee_code,
      employeeName: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
      departmentId: row.department_id,
      departmentName: row.department_name,
      designationName: row.designation_name,
      supervisorId: row.supervisor_id,
      supervisorName: row.supervisor_name,
      attendanceId: row.attendance_id,
      status: row.status,
      statusCode: row.status ? STATUS_CODES[row.status] ?? row.status : null,
      leaveTypeId: row.leave_type_id,
      leaveTypeName: row.leave_type_name,
      shiftId: row.shift_id,
      shiftCode: row.shift_code,
      shiftName: row.shift_name,
      remarks: row.remarks,
      isLocked: row.locked_by_payroll_run_id !== null,
      // What the configured calendar says this day is, before any marking.
      dayKind: day.kind,
      holidayName: day.holidayName,
      suggestedStatus: day.kind === 'HOLIDAY' ? 'HOLIDAY' : day.kind === 'WEEKLY_OFF' ? 'WEEKLY_OFF' : 'PRESENT',
    }
  })

  const summary = {
    total: items.length,
    marked: items.filter((item) => item.status !== null).length,
    unmarked: items.filter((item) => item.status === null).length,
    present: items.filter((item) => item.status === 'PRESENT').length,
    absent: items.filter((item) => item.status === 'ABSENT').length,
    onLeave: items.filter((item) => item.status === 'ON_LEAVE').length,
    halfDay: items.filter((item) => item.status === 'HALF_DAY_LEAVE').length,
    holiday: items.filter((item) => item.status === 'HOLIDAY').length,
    weeklyOff: items.filter((item) => item.status === 'WEEKLY_OFF').length,
  }

  return { date: query.date, canManage, summary, employees: items }
}

export async function listAttendance(auth: AuthContext, query: AttendanceListQuery) {
  if (query.to < query.from) throw ApiError.badRequest('The end date cannot be before the start date')

  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)
  const rows = await repository.listAttendance(clause, query)
  return rows.map(presentAttendance)
}

/**
 * The monthly calendar for one employee (plan section 7).
 *
 * Days with no attendance record still appear, resolved from the configured
 * calendar, so a month always renders completely.
 */
export async function getMonthlyCalendar(auth: AuthContext, query: MonthlyQuery) {
  const scope = viewScope(auth)

  const employeeId =
    !query.employeeId || query.employeeId === 'me'
      ? auth.employeeId
      : query.employeeId
  if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
  await assertEmployeeInScope(auth, employeeId, scope)

  // The attendance month must resolve to the exact same window payroll uses for
  // that month, or paid-days math between the two silently disagrees. A run's
  // dates can be changed, so use the run's own when there is one.
  const run = await queryOne<{ period_start: IsoDate; period_end: IsoDate }>(
    pool,
    'SELECT period_start, period_end FROM payroll_runs WHERE organization_id = $1 AND year = $2 AND month = $3',
    [auth.organizationId, query.year, query.month],
  )
  const standard = payCycleFor(query.year, query.month, PAYROLL_CYCLE_CUTOFF_DAY)
  const from = run?.period_start ?? standard.start
  const to = run?.period_end ?? standard.end

  const employee = await queryOne<{
    id: string
    employee_code: string
    first_name: string
    last_name: string | null
    department_id: string | null
    location_id: string | null
    joining_date: IsoDate
    exit_date: IsoDate | null
  }>(
    pool,
    `SELECT id, employee_code, first_name, last_name, department_id, location_id, joining_date, exit_date
       FROM employees WHERE id = $1 AND organization_id = $2`,
    [employeeId, auth.organizationId],
  )
  if (!employee) throw ApiError.notFound('Employee')

  const [records, calendar] = await Promise.all([
    repository.listAttendanceForEmployees([employeeId], from, to),
    buildCalendarContext(auth.organizationId, from, to),
  ])

  const byDate = new Map(records.map((record) => [record.attendance_date, record]))
  const employeeScope = { departmentId: employee.department_id, locationId: employee.location_id, employeeId: employee.id }

  const days = datesBetween(from, to).map((date) => {
    const record = byDate.get(date)
    const day = calendar.dayFor(date, employeeScope)
    const employed = date >= employee.joining_date && (!employee.exit_date || date <= employee.exit_date)

    // Without an explicit record, fall back to what the calendar says the day is.
    const derivedStatus = !employed
      ? null
      : day.kind === 'HOLIDAY'
        ? 'HOLIDAY'
        : day.kind === 'WEEKLY_OFF'
          ? 'WEEKLY_OFF'
          : null

    const status = record?.status ?? derivedStatus

    return {
      date,
      status,
      statusCode: status ? STATUS_CODES[status] ?? status : null,
      isMarked: Boolean(record),
      isEmployed: employed,
      dayKind: day.kind,
      holidayName: day.holidayName,
      leaveTypeId: record?.leave_type_id ?? null,
      remarks: record?.remarks ?? null,
      isLocked: Boolean(record?.locked_by_payroll_run_id),
    }
  })

  const counts = days.reduce<Record<string, number>>((totals, day) => {
    if (day.status) totals[day.status] = (totals[day.status] ?? 0) + 1
    return totals
  }, {})

  return {
    employee: {
      id: employee.id,
      employeeCode: employee.employee_code,
      name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
    },
    year: query.year,
    month: query.month,
    monthLabel: monthLabel(query.year, query.month),
    from,
    to,
    workingDays: calendar.countWorkingDays(employeeScope),
    counts: {
      present: counts.PRESENT ?? 0,
      absent: counts.ABSENT ?? 0,
      onLeave: counts.ON_LEAVE ?? 0,
      halfDayLeave: counts.HALF_DAY_LEAVE ?? 0,
      holiday: counts.HOLIDAY ?? 0,
      weeklyOff: counts.WEEKLY_OFF ?? 0,
      unmarked: days.filter((day) => day.isEmployed && !day.status).length,
    },
    days,
  }
}

export async function getAttendanceHistory(auth: AuthContext, attendanceId: string) {
  const record = await repository.findAttendanceById(attendanceId, auth.organizationId)
  if (!record) throw ApiError.notFound('Attendance record')
  await assertEmployeeInScope(auth, record.employee_id, viewScope(auth))
  return repository.listAttendanceHistory(attendanceId)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Validates the leave type belongs to the organization when leave is marked. */
async function assertLeaveTypeValid(
  organizationId: string,
  leaveTypeId: string | null | undefined,
  db: Queryable,
): Promise<void> {
  if (!leaveTypeId) return
  const row = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM leave_types WHERE id = $1 AND organization_id = $2 AND is_active',
    [leaveTypeId, organizationId],
  )
  if (!row) throw ApiError.badRequest('The selected leave type does not exist')
}

async function assertEmployedOn(employeeId: string, date: IsoDate, db: Queryable): Promise<void> {
  const row = await queryOne<{ joining_date: IsoDate; exit_date: IsoDate | null }>(
    db,
    'SELECT joining_date, exit_date FROM employees WHERE id = $1',
    [employeeId],
  )
  if (!row) throw ApiError.notFound('Employee')
  if (date < row.joining_date) {
    throw ApiError.businessRule('Attendance cannot be marked before the employee joined')
  }
  if (row.exit_date && date > row.exit_date) {
    throw ApiError.businessRule('Attendance cannot be marked after the employee left')
  }
}

export async function markAttendance(auth: AuthContext, input: MarkAttendanceInput, context: AuditContext) {
  const scope = manageScope(auth)

  const saved = await withTransaction(async (tx) => {
    await assertEmployeeInScope(auth, input.employeeId, scope, tx)
    await assertEmployedOn(input.employeeId, input.attendanceDate, tx)
    await assertLeaveTypeValid(auth.organizationId, input.leaveTypeId, tx)

    const existing = await assertNotPayrollLocked(input.employeeId, input.attendanceDate, tx)

    const row = await repository.upsertAttendance(
      {
        organizationId: auth.organizationId,
        employeeId: input.employeeId,
        attendanceDate: input.attendanceDate,
        status: input.status,
        leaveTypeId: input.leaveTypeId ?? null,
        shiftId: input.shiftId ?? null,
        source: 'MANUAL',
        remarks: input.remarks ?? null,
        userId: auth.userId,
      },
      tx,
    )

    await repository.recordAttendanceHistory(
      {
        attendanceId: row.id,
        organizationId: auth.organizationId,
        employeeId: input.employeeId,
        attendanceDate: input.attendanceDate,
        previousStatus: existing?.status ?? null,
        newStatus: input.status,
        reason: input.remarks ?? null,
        changedBy: auth.userId,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: existing ? 'ATTENDANCE_CHANGED' : 'ATTENDANCE_MARKED',
        entityType: 'attendance',
        entityId: row.id,
        oldValues: existing ? { status: existing.status } : undefined,
        newValues: { employeeId: input.employeeId, date: input.attendanceDate, status: input.status },
      },
      tx,
    )

    return {
      id: row.id,
      employeeId: row.employee_id,
      attendanceDate: row.attendance_date,
      status: row.status,
      statusCode: STATUS_CODES[row.status] ?? row.status,
      shiftId: row.shift_id,
      remarks: row.remarks,
    }
  })

  // After the commit, so a rolled-back save cannot send a WhatsApp message.
  await checkAbsenceStreaks(auth.organizationId, [input.employeeId])
  return saved
}

export async function updateAttendance(
  auth: AuthContext,
  attendanceId: string,
  input: UpdateAttendanceInput,
  context: AuditContext,
) {
  const scope = manageScope(auth)

  return withTransaction(async (tx) => {
    const existing = await repository.findAttendanceById(attendanceId, auth.organizationId, tx)
    if (!existing) throw ApiError.notFound('Attendance record')

    await assertEmployeeInScope(auth, existing.employee_id, scope, tx)
    if (existing.locked_by_payroll_run_id) {
      throw ApiError.businessRule(
        'This attendance date is part of a locked payroll run and can no longer be edited. Raise a payroll adjustment instead.',
      )
    }
    await assertLeaveTypeValid(auth.organizationId, input.leaveTypeId, tx)

    const row = await repository.upsertAttendance(
      {
        organizationId: auth.organizationId,
        employeeId: existing.employee_id,
        attendanceDate: existing.attendance_date,
        status: input.status,
        leaveTypeId: input.leaveTypeId ?? null,
        leaveRequestId: existing.leave_request_id,
        shiftId: input.shiftId !== undefined ? input.shiftId : existing.shift_id,
        source: 'MANUAL',
        remarks: input.remarks ?? existing.remarks,
        userId: auth.userId,
      },
      tx,
    )

    await repository.recordAttendanceHistory(
      {
        attendanceId: row.id,
        organizationId: auth.organizationId,
        employeeId: existing.employee_id,
        attendanceDate: existing.attendance_date,
        previousStatus: existing.status,
        newStatus: input.status,
        reason: input.reason ?? null,
        changedBy: auth.userId,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'ATTENDANCE_CHANGED',
        entityType: 'attendance',
        entityId: row.id,
        oldValues: { status: existing.status },
        newValues: { status: input.status, reason: input.reason ?? null },
      },
      tx,
    )

    return {
      id: row.id,
      employeeId: row.employee_id,
      attendanceDate: row.attendance_date,
      status: row.status,
      statusCode: STATUS_CODES[row.status] ?? row.status,
      shiftId: row.shift_id,
      remarks: row.remarks,
    }
  })
}

export interface BulkResult {
  date: IsoDate
  saved: number
  skipped: { employeeId: string; reason: string }[]
}

/**
 * Bulk marking, used by "Mark All Present" and by saving the daily sheet.
 *
 * The whole batch runs in one transaction (plan section 56), but individual
 * employees that fail a domain rule are reported back rather than aborting the
 * save for everyone else - a single locked date should not block the sheet.
 */
export async function bulkMarkAttendance(
  auth: AuthContext,
  input: BulkMarkAttendanceInput,
  context: AuditContext,
): Promise<BulkResult> {
  const scope = manageScope(auth)

  const entries: {
    employeeId: string
    status: string
    leaveTypeId?: string | null
    shiftId?: string | null
    remarks?: string | null
  }[] = []
  for (const entry of input.entries ?? []) {
    entries.push(entry)
  }
  for (const employeeId of input.employeeIds ?? []) {
    if (entries.some((entry) => entry.employeeId === employeeId)) continue
    entries.push({ employeeId, status: input.defaultStatus as string, remarks: input.remarks ?? null })
  }

  if (entries.length === 0) throw ApiError.badRequest('No employees were supplied')

  const result = await withTransaction(async (tx: TxClient) => {
    const skipped: { employeeId: string; reason: string }[] = []
    let saved = 0

    for (const entry of entries) {
      try {
        await assertEmployeeInScope(auth, entry.employeeId, scope, tx)
        await assertEmployedOn(entry.employeeId, input.attendanceDate, tx)
        await assertLeaveTypeValid(auth.organizationId, entry.leaveTypeId, tx)

        const existing = await repository.findAttendanceForDate(entry.employeeId, input.attendanceDate, tx)
        if (existing?.locked_by_payroll_run_id) {
          skipped.push({ employeeId: entry.employeeId, reason: 'Date is locked by a payroll run' })
          continue
        }

        const row = await repository.upsertAttendance(
          {
            organizationId: auth.organizationId,
            employeeId: entry.employeeId,
            attendanceDate: input.attendanceDate,
            status: entry.status,
            leaveTypeId: entry.leaveTypeId ?? null,
            shiftId: entry.shiftId ?? null,
            source: 'BULK',
            remarks: entry.remarks ?? input.remarks ?? null,
            userId: auth.userId,
          },
          tx,
        )

        await repository.recordAttendanceHistory(
          {
            attendanceId: row.id,
            organizationId: auth.organizationId,
            employeeId: entry.employeeId,
            attendanceDate: input.attendanceDate,
            previousStatus: existing?.status ?? null,
            newStatus: entry.status,
            reason: 'Bulk attendance update',
            changedBy: auth.userId,
          },
          tx,
        )

        saved += 1
      } catch (error) {
        if (error instanceof ApiError && error.statusCode < 500) {
          skipped.push({ employeeId: entry.employeeId, reason: error.message })
          continue
        }
        throw error
      }
    }

    await recordAudit(
      {
        ...context,
        action: 'ATTENDANCE_BULK_MARKED',
        entityType: 'attendance',
        entityId: null,
        newValues: { date: input.attendanceDate, saved, skipped: skipped.length },
      },
      tx,
    )

    return { date: input.attendanceDate, saved, skipped }
  })

  // Only the employees this batch actually wrote; a skipped row changed nothing.
  const skippedIds = new Set(result.skipped.map((entry) => entry.employeeId))
  await checkAbsenceStreaks(
    auth.organizationId,
    entries.map((entry) => entry.employeeId).filter((id) => !skippedIds.has(id)),
  )
  return result
}

/**
 * Brings a range in line with the calendar's holidays and weekly offs, so a
 * month's attendance is complete before payroll runs:
 *
 *  1. Days the calendar put down as Holiday / Weekly Off that it no longer says
 *     are off (a holiday was deleted or moved) go back to "not marked".
 *  2. Unmarked days are then filled from the calendar as it stands now.
 *
 * Only calendar-derived records are cleared (see listCalendarDerivedRecords);
 * days someone marked on purpose are never touched.
 */
export async function applyCalendarDefaults(
  auth: AuthContext,
  from: IsoDate,
  to: IsoDate,
  context: AuditContext,
): Promise<{ created: number; cleared: number }> {
  return withTransaction((tx) => applyCalendarWithin(auth, from, to, context, tx))
}

/** The body of applyCalendarDefaults, run on a caller-supplied transaction (also used by tests). */
export async function applyCalendarWithin(
  auth: AuthContext,
  from: IsoDate,
  to: IsoDate,
  context: AuditContext,
  tx: TxClient,
): Promise<{ created: number; cleared: number }> {
  const scope = manageScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)

  const calendar = await buildCalendarContext(auth.organizationId, from, to, tx)
  let created = 0

  const derived = await repository.listCalendarDerivedRecords(clause, from, to, tx)
  const stale = derived.filter((row) => {
    const kind = calendar.dayFor(row.attendance_date, {
      departmentId: row.department_id,
      locationId: row.location_id,
      employeeId: row.employee_id,
    }).kind
    return row.status === 'HOLIDAY' ? kind !== 'HOLIDAY' : kind !== 'WEEKLY_OFF'
  })
  // Removing a record removes its history with it, so what was cleared is kept in the audit log.
  const cleared = await repository.deleteAttendanceByIds(
    stale.map((row) => row.id),
    tx,
  )

  // One sheet per date keeps the employee/eligibility rules in a single place.
  for (const date of datesBetween(from, to)) {
    const sheet = await repository.dailySheet(clause, date, { unmarkedOnly: true }, tx)
    for (const row of sheet) {
      const day = calendar.dayFor(date, {
        departmentId: row.department_id,
        locationId: row.location_id,
        employeeId: row.employee_id,
      })
      if (day.kind === 'WORKING') continue

      const attendance = await repository.upsertAttendance(
        {
          organizationId: auth.organizationId,
          employeeId: row.employee_id,
          attendanceDate: date,
          status: day.kind === 'HOLIDAY' ? 'HOLIDAY' : 'WEEKLY_OFF',
          holidayId: day.holidayId,
          source: day.kind === 'HOLIDAY' ? 'HOLIDAY_RULE' : 'WEEKLY_OFF_RULE',
          remarks: day.holidayName,
          userId: auth.userId,
        },
        tx,
      )
      await repository.recordAttendanceHistory(
        {
          attendanceId: attendance.id,
          organizationId: auth.organizationId,
          employeeId: row.employee_id,
          attendanceDate: date,
          previousStatus: null,
          newStatus: attendance.status,
          reason: 'Applied from calendar configuration',
          changedBy: auth.userId,
        },
        tx,
      )
      created += 1
    }
  }

  await recordAudit(
    {
      ...context,
      action: 'ATTENDANCE_BULK_MARKED',
      entityType: 'attendance',
      entityId: null,
      newValues: {
        from,
        to,
        created,
        cleared,
        source: 'CALENDAR_DEFAULTS',
        clearedRecords: stale.slice(0, 1000).map((row) => ({
          employeeCode: row.employee_code,
          date: row.attendance_date,
          status: row.status,
        })),
      },
    },
    tx,
  )

  return { created, cleared }
}

/** Status totals for a range, used by dashboards and reports. */
export async function getSummary(auth: AuthContext, from: IsoDate, to: IsoDate) {
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)
  const rows = await repository.countByStatus(clause, from, to)

  const counts: Record<string, number> = {
    PRESENT: 0,
    ABSENT: 0,
    ON_LEAVE: 0,
    HALF_DAY_LEAVE: 0,
    HOLIDAY: 0,
    WEEKLY_OFF: 0,
  }
  for (const row of rows) counts[row.status] = Number(row.count)

  return {
    from,
    to,
    present: counts.PRESENT ?? 0,
    absent: counts.ABSENT ?? 0,
    onLeave: counts.ON_LEAVE ?? 0,
    halfDayLeave: counts.HALF_DAY_LEAVE ?? 0,
    holiday: counts.HOLIDAY ?? 0,
    weeklyOff: counts.WEEKLY_OFF ?? 0,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
  }
}
