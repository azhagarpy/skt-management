import type { Request, Response } from 'express'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { ApiError } from '../../utils/api-error.js'
import { withTransaction, type TxClient } from '../../database/tx.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause } from '../employees/employee-access.js'
import { addDays, weekdayOf } from '../../utils/dates.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './calendar.repository.js'
import { buildCalendarContext } from './calendar.service.js'
import type {
  AssignWeeklyOffInput,
  GrantOneOffWeeklyOffInput,
  HolidayCalendarInput,
  HolidayInput,
  HolidayListQuery,
  ShiftInput,
  UnassignWeeklyOffInput,
  UpdateHolidayInput,
  UpdateShiftInput,
  WeeklyOffCalendarQuery,
  WeeklyOffRuleInput,
  WorkingDaysQuery,
} from './calendar.validation.js'

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

function presentRule(row: repository.WeeklyOffRuleWithDays) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    departmentId: row.department_id,
    locationId: row.location_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    priority: row.priority,
    isActive: row.is_active,
    days: row.days.map((day) => ({
      weekday: day.weekday,
      occurrences: day.occurrences,
      includeLast: day.include_last,
      isHalfDay: day.is_half_day,
    })),
  }
}

function presentHoliday(row: repository.HolidayRow) {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    calendarName: row.calendar_name ?? null,
    name: row.name,
    holidayDate: row.holiday_date,
    description: row.description,
    isOptional: row.is_optional,
    isPaid: row.is_paid,
    extraPayIfWorked: row.extra_pay_if_worked,
  }
}

function presentShift(row: repository.ShiftRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    startTime: row.start_time,
    endTime: row.end_time,
    breakMinutes: row.break_minutes,
    isNightShift: row.is_night_shift,
    isActive: row.is_active,
  }
}

// ---------------------------------------------------------------------------
// Weekly offs
// ---------------------------------------------------------------------------

export const listWeeklyOffRules = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const rows = await repository.listWeeklyOffRules(auth.organizationId)
  return sendSuccess(res, rows.map(presentRule))
})

export const createWeeklyOffRule = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as WeeklyOffRuleInput

  const created = await withTransaction(async (tx) => {
    const rule = await repository.insertWeeklyOffRule(
      {
        organization_id: auth.organizationId,
        department_id: input.departmentId ?? null,
        location_id: input.locationId ?? null,
        name: input.name,
        description: input.description ?? null,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        priority: input.priority,
        is_active: input.isActive,
        created_by: auth.userId,
      },
      tx,
    )
    await repository.replaceWeeklyOffRuleDays(
      rule.id,
      input.days.map((day) => ({
        weekday: day.weekday,
        occurrences: day.occurrences ?? null,
        includeLast: day.includeLast,
        isHalfDay: day.isHalfDay,
      })),
      tx,
    )
    return repository.findWeeklyOffRule(rule.id, auth.organizationId, tx)
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'weekly_off_rule',
    entityId: created?.id ?? null,
    newValues: { name: input.name, days: input.days },
  })

  return sendCreated(res, created ? presentRule(created) : null, 'Weekly off rule created successfully')
})

export const updateWeeklyOffRule = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const input = req.body as WeeklyOffRuleInput

  const existing = await repository.findWeeklyOffRule(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Weekly off rule')

  const updated = await withTransaction(async (tx) => {
    await repository.updateWeeklyOffRule(
      id,
      auth.organizationId,
      {
        department_id: input.departmentId ?? null,
        location_id: input.locationId ?? null,
        name: input.name,
        description: input.description ?? null,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        priority: input.priority,
        is_active: input.isActive,
      },
      tx,
    )
    await repository.replaceWeeklyOffRuleDays(
      id,
      input.days.map((day) => ({
        weekday: day.weekday,
        occurrences: day.occurrences ?? null,
        includeLast: day.includeLast,
        isHalfDay: day.isHalfDay,
      })),
      tx,
    )
    return repository.findWeeklyOffRule(id, auth.organizationId, tx)
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'weekly_off_rule',
    entityId: id,
    oldValues: presentRule(existing),
    newValues: { name: input.name, days: input.days },
  })

  return sendSuccess(res, updated ? presentRule(updated) : null, 'Weekly off rule updated successfully')
})

export const deleteWeeklyOffRule = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const existing = await repository.findWeeklyOffRule(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Weekly off rule')

  await repository.deleteWeeklyOffRule(id, auth.organizationId)
  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'weekly_off_rule',
    entityId: id,
    oldValues: presentRule(existing),
  })
  return sendNoContent(res, 'Weekly off rule deleted successfully')
})

// ---------------------------------------------------------------------------
// Per-employee weekly off assignments
//
// Admins assign any employee; supervisors assign only their own team - the same
// ALL/TEAM scope split attendance and leave already use.
// ---------------------------------------------------------------------------

function weeklyOffAssignScope(auth: AuthContext) {
  return resolveScope(auth, { all: PERMISSIONS.WEEKLY_OFF_MANAGE, team: PERMISSIONS.WEEKLY_OFF_ASSIGN_TEAM })
}

function presentWeeklyOffAssignment(row: repository.EmployeeWeeklyOffAssignmentRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    weekday: row.weekday,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }
}

/**
 * A window of days (a week by default, or a whole visible calendar month for
 * the full-screen view), rendered per in-scope employee, so the calendar UI
 * can show who is already off on which day before the admin/supervisor
 * assigns anyone new.
 */
export const getWeeklyOffCalendar = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const query = req.query as unknown as WeeklyOffCalendarQuery
  const scope = weeklyOffAssignScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)

  const windowEnd = addDays(query.weekStart, query.days - 1)
  const dates = Array.from({ length: query.days }, (_, offset) => addDays(query.weekStart, offset))

  const [employees, calendar] = await Promise.all([
    repository.listEmployeesForWeeklyOffCalendar(clause, {
      departmentId: query.departmentId,
      supervisorId: query.supervisorId,
      search: query.search,
    }),
    buildCalendarContext(auth.organizationId, query.weekStart, windowEnd),
  ])

  const rows = employees.map((employee) => ({
    employeeId: employee.employee_id,
    employeeCode: employee.employee_code,
    employeeName: [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' '),
    departmentId: employee.department_id,
    departmentName: employee.department_name,
    supervisorId: employee.supervisor_id,
    supervisorName: employee.supervisor_name,
    days: dates.map((date) => {
      const day = calendar.dayFor(date, {
        departmentId: employee.department_id,
        locationId: employee.location_id,
        employeeId: employee.employee_id,
      })
      return { date, weekday: weekdayOf(date), isWeeklyOff: day.kind === 'WEEKLY_OFF' }
    }),
  }))

  return sendSuccess(res, { weekStart: query.weekStart, dates, employees: rows })
})

export const assignWeeklyOff = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as AssignWeeklyOffInput
  const scope = weeklyOffAssignScope(auth)

  const created = await withTransaction(async (tx: TxClient) => {
    const rows: repository.EmployeeWeeklyOffAssignmentRow[] = []
    for (const employeeId of input.employeeIds) {
      await assertEmployeeInScope(auth, employeeId, scope, tx)
      // A new assignment fully replaces whatever this employee had before -
      // "used for upcoming not configured weeks" means one active pattern at a
      // time, not an accumulating list.
      await repository.closeOpenWeeklyOffAssignment(employeeId, input.effectiveFrom, tx)
      const row = await repository.insertWeeklyOffAssignment(
        {
          organization_id: auth.organizationId,
          employee_id: employeeId,
          weekday: input.weekday,
          effective_from: input.effectiveFrom,
          effective_to: null,
          created_by: auth.userId,
        },
        tx,
      )
      rows.push(row)
    }
    return rows
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'employee_weekly_off_assignment',
    entityId: null,
    newValues: { weekday: input.weekday, effectiveFrom: input.effectiveFrom, employeeIds: input.employeeIds },
  })

  return sendCreated(res, created.map(presentWeeklyOffAssignment), 'Weekly off assigned successfully')
})

/**
 * Removes an employee's weekly off from a given date onward - whichever kind
 * granted it. Used when unchecking an already-off employee in the calendar
 * assignment modal, so unticking someone actually takes their day back.
 */
export const unassignWeeklyOff = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as UnassignWeeklyOffInput
  const scope = weeklyOffAssignScope(auth)

  await withTransaction(async (tx: TxClient) => {
    for (const employeeId of input.employeeIds) {
      await assertEmployeeInScope(auth, employeeId, scope, tx)
      await repository.deleteExtraWeeklyOffForDate(employeeId, input.date, tx)
      await repository.closeOpenWeeklyOffAssignment(employeeId, input.date, tx)
    }
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'employee_weekly_off_assignment',
    entityId: null,
    newValues: { date: input.date, employeeIds: input.employeeIds, removed: true },
  })

  return sendNoContent(res, 'Weekly off removed successfully')
})

export const grantOneOffWeeklyOff = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as GrantOneOffWeeklyOffInput
  const scope = weeklyOffAssignScope(auth)

  await withTransaction(async (tx: TxClient) => {
    for (const employeeId of input.employeeIds) {
      await assertEmployeeInScope(auth, employeeId, scope, tx)
    }
    await repository.insertExtraWeeklyOffs(
      auth.organizationId,
      input.employeeIds,
      input.offDate,
      'ADMIN_ASSIGNED',
      auth.userId,
      tx,
    )
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'employee_extra_weekly_off',
    entityId: null,
    newValues: { offDate: input.offDate, employeeIds: input.employeeIds },
  })

  return sendCreated(res, { offDate: input.offDate, employeeIds: input.employeeIds }, 'Weekly off granted successfully')
})

export const deleteWeeklyOffAssignment = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const scope = weeklyOffAssignScope(auth)

  const existing = await repository.findWeeklyOffAssignment(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Weekly off assignment')
  await assertEmployeeInScope(auth, existing.employee_id, scope)

  await repository.deleteWeeklyOffAssignment(id, auth.organizationId)
  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'employee_weekly_off_assignment',
    entityId: id,
    oldValues: presentWeeklyOffAssignment(existing),
  })
  return sendNoContent(res, 'Weekly off assignment removed successfully')
})

export const deleteExtraWeeklyOff = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const scope = weeklyOffAssignScope(auth)

  const existing = await repository.findExtraWeeklyOff(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Weekly off grant')
  await assertEmployeeInScope(auth, existing.employee_id, scope)

  await repository.deleteExtraWeeklyOff(id, auth.organizationId)
  await recordAudit({
    ...auditContextFrom(req),
    action: 'WEEKLY_OFF_UPDATED',
    entityType: 'employee_extra_weekly_off',
    entityId: id,
    oldValues: { employeeId: existing.employee_id, offDate: existing.off_date },
  })
  return sendNoContent(res, 'Weekly off grant removed successfully')
})

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export const listHolidays = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const rows = await repository.listHolidays(auth.organizationId, req.query as unknown as HolidayListQuery)
  return sendSuccess(res, rows.map(presentHoliday))
})

export const createHoliday = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as HolidayInput

  let calendarId = input.calendarId ?? null
  if (!calendarId) {
    // Fall back to the default calendar for the holiday's year, creating one if needed.
    const year = Number(input.holidayDate.slice(0, 4))
    const existing = await repository.findDefaultCalendar(auth.organizationId, year)
    calendarId =
      existing?.id ??
      (
        await repository.insertHolidayCalendar({
          organization_id: auth.organizationId,
          name: `${year} Holidays`,
          year,
          is_default: true,
        })
      ).id
  }

  const row = await repository.insertHoliday({
    organization_id: auth.organizationId,
    calendar_id: calendarId,
    name: input.name,
    holiday_date: input.holidayDate,
    description: input.description ?? null,
    is_optional: input.isOptional,
    is_paid: input.isPaid,
    extra_pay_if_worked: input.extraPayIfWorked,
    created_by: auth.userId,
  })

  await recordAudit({
    ...auditContextFrom(req),
    action: 'HOLIDAY_CREATED',
    entityType: 'holiday',
    entityId: row.id,
    newValues: presentHoliday(row),
  })

  return sendCreated(res, presentHoliday(row), 'Holiday created successfully')
})

export const updateHoliday = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const input = req.body as UpdateHolidayInput

  const existing = await repository.findHoliday(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Holiday')

  const updated = await repository.updateHoliday(id, auth.organizationId, {
    calendar_id: input.calendarId,
    name: input.name,
    holiday_date: input.holidayDate,
    description: input.description,
    is_optional: input.isOptional,
    is_paid: input.isPaid,
    extra_pay_if_worked: input.extraPayIfWorked,
  })
  if (!updated) throw ApiError.notFound('Holiday')

  await recordAudit({
    ...auditContextFrom(req),
    action: 'HOLIDAY_UPDATED',
    entityType: 'holiday',
    entityId: id,
    oldValues: presentHoliday(existing),
    newValues: presentHoliday(updated),
  })

  return sendSuccess(res, presentHoliday(updated), 'Holiday updated successfully')
})

export const deleteHoliday = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const id = req.params.id as string
  const existing = await repository.findHoliday(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Holiday')

  await repository.deleteHoliday(id, auth.organizationId)
  await recordAudit({
    ...auditContextFrom(req),
    action: 'HOLIDAY_DELETED',
    entityType: 'holiday',
    entityId: id,
    oldValues: presentHoliday(existing),
  })
  return sendNoContent(res, 'Holiday deleted successfully')
})

export const listHolidayCalendars = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const year = (req.query as { year?: string }).year
  const rows = await repository.listHolidayCalendars(auth.organizationId, year ? Number(year) : undefined)
  return sendSuccess(
    res,
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      year: row.year,
      locationId: row.location_id,
      isDefault: row.is_default,
      isActive: row.is_active,
      holidayCount: Number(row.holiday_count ?? 0),
    })),
  )
})

export const createHolidayCalendar = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as HolidayCalendarInput
  const row = await repository.insertHolidayCalendar({
    organization_id: auth.organizationId,
    name: input.name,
    year: input.year,
    location_id: input.locationId ?? null,
    is_default: input.isDefault,
    is_active: input.isActive,
  })
  return sendCreated(res, { id: row.id, name: row.name, year: row.year }, 'Holiday calendar created successfully')
})

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export const listShifts = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const rows = await repository.listShifts(auth.organizationId)
  return sendSuccess(res, rows.map(presentShift))
})

export const createShift = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as ShiftInput
  const row = await repository.insertShift({
    organization_id: auth.organizationId,
    name: input.name,
    code: input.code,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
    break_minutes: input.breakMinutes,
    is_night_shift: input.isNightShift,
    is_active: input.isActive,
  })
  return sendCreated(res, presentShift(row), 'Shift created successfully')
})

export const updateShift = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as UpdateShiftInput
  const row = await repository.updateShift(req.params.id as string, auth.organizationId, {
    name: input.name,
    code: input.code,
    start_time: input.startTime,
    end_time: input.endTime,
    break_minutes: input.breakMinutes,
    is_night_shift: input.isNightShift,
    is_active: input.isActive,
  })
  if (!row) throw ApiError.notFound('Shift')
  return sendSuccess(res, presentShift(row), 'Shift updated successfully')
})

export const deleteShift = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const deleted = await repository.deleteShift(req.params.id as string, auth.organizationId)
  if (!deleted) throw ApiError.notFound('Shift')
  return sendNoContent(res, 'Shift deleted successfully')
})

/**
 * Resolves a date range into working days, weekly offs and holidays. The
 * attendance and payroll screens use this to render a month without duplicating
 * the rule logic on the client.
 */
export const getWorkingDays = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const query = req.query as unknown as WorkingDaysQuery

  if (query.to < query.from) throw ApiError.badRequest('The end date cannot be before the start date')

  const calendar = await buildCalendarContext(auth.organizationId, query.from, query.to)
  const scope = { departmentId: query.departmentId ?? null, locationId: query.locationId ?? null }
  const days = calendar.daysFor(scope)

  return sendSuccess(res, {
    from: query.from,
    to: query.to,
    workingDays: calendar.countWorkingDays(scope),
    days,
  })
})
