import { ApiError } from '../../utils/api-error.js'
import { withAdvisoryLock, withTransaction } from '../../database/tx.js'
import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { datesBetween, formatDayMonthYear, monthLabel, type IsoDate } from '../../utils/dates.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import {
  assertCanManageEmployee,
  assertEmployeeInScope,
  resolveScope,
  scopeClause,
  type EmployeeScope,
} from '../employees/employee-access.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import * as calendarRepository from '../calendar/calendar.repository.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './overtime.repository.js'
import type { PaidOffCalendarQuery, PaidOffListQuery, SchedulePaidOffInput } from './overtime.validation.js'

/**
 * Paid offs: what a Supply employee's overtime earns.
 *
 * Every 8 hours of overtime in a week (Monday to Sunday) earns one paid off, up
 * to 2 a week; hours short of a full 8 do not carry into the next week. A paid
 * off is a day off that payroll pays as a day worked (DayInput.paidOff), on a
 * date an administrator, manager or supervisor chooses from the employee's
 * balance. It is an employee_extra_weekly_offs row with source PAID_OFF, so the
 * calendar shows it as that employee's weekly off.
 */

export const HOURS_PER_PAID_OFF = 8
export const MAX_PAID_OFFS_PER_WEEK = 2

/** The paid offs one week's overtime hours earn. */
export function paidOffsForWeek(hours: number): number {
  return Math.min(Math.floor(hours / HOURS_PER_PAID_OFF), MAX_PAID_OFFS_PER_WEEK)
}

export interface PaidOffBalance {
  /** Paid offs earned by overtime, over every week. */
  earned: number
  /** Extra weekly offs that overtime became before paid offs; they used up the overtime too. */
  convertedBefore: number
  /** Paid offs given a date, in date order. */
  scheduled: { id: string; date: IsoDate }[]
  /** Earned and not yet given a date. */
  available: number
}

/** A balance from each week's overtime hours and the offs already given for it. */
export function paidOffBalance(
  weeklyHours: number[],
  offs: Pick<repository.OvertimeOffRow, 'id' | 'off_date' | 'source'>[],
): PaidOffBalance {
  const earned = weeklyHours.reduce((total, hours) => total + paidOffsForWeek(hours), 0)
  const convertedBefore = offs.filter((off) => off.source === 'OVERTIME_CONVERSION').length
  const scheduled = offs.filter((off) => off.source === 'PAID_OFF').map((off) => ({ id: off.id, date: off.off_date }))
  return { earned, convertedBefore, scheduled, available: Math.max(0, earned - convertedBefore - scheduled.length) }
}

/** Each employee's balance, in two queries. */
export async function loadPaidOffBalances(employeeIds: string[], db: Queryable = pool): Promise<Map<string, PaidOffBalance>> {
  const [weeks, offs] = await Promise.all([
    repository.sumOvertimeHoursByWeek(employeeIds, db),
    repository.listOvertimeOffs(employeeIds, db),
  ])
  return new Map(
    employeeIds.map((id) => [
      id,
      paidOffBalance(
        weeks.filter((week) => week.employee_id === id).map((week) => Number(week.hours)),
        offs.filter((off) => off.employee_id === id),
      ),
    ]),
  )
}

/**
 * Refuses an overtime change that would leave paid offs scheduled without the
 * overtime that earned them. Run after the change, inside its transaction, so
 * the change is undone.
 */
export async function assertPaidOffsStillEarned(employeeId: string, db: Queryable): Promise<void> {
  const balance = (await loadPaidOffBalances([employeeId], db)).get(employeeId)
  if (!balance) return
  const backed = Math.max(0, balance.earned - balance.convertedBefore)
  if (balance.scheduled.length > backed) {
    throw ApiError.businessRule(
      `That would leave ${balance.scheduled.length} paid off(s) scheduled but only ${backed} earned by overtime. Remove a scheduled paid off first.`,
    )
  }
}

function viewScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.OVERTIME_VIEW_ALL,
    team: PERMISSIONS.OVERTIME_VIEW_TEAM,
    self: PERMISSIONS.OVERTIME_VIEW_SELF,
  })
}

/** Choosing and removing paid offs: everyone, or the caller's team but never themselves. */
function manageScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, { all: PERMISSIONS.OVERTIME_MANAGE_ALL, team: PERMISSIONS.OVERTIME_MANAGE_TEAM })
}

interface PayrollRunForDate {
  year: number
  month: number
  status: string
}

/** The payroll run whose dates hold `date`, if one has been created. */
async function payrollRunFor(organizationId: string, date: IsoDate, db: Queryable): Promise<PayrollRunForDate | null> {
  return queryOne<PayrollRunForDate>(
    db,
    `SELECT year, month, status::text AS status FROM payroll_runs
      WHERE organization_id = $1 AND period_start <= $2 AND period_end >= $2
      LIMIT 1`,
    [organizationId, date],
  )
}

const isClosed = (run: PayrollRunForDate | null): boolean => run?.status === 'APPROVED' || run?.status === 'LOCKED'
const needsRecalculation = (run: PayrollRunForDate | null): boolean =>
  run?.status === 'CALCULATED' || run?.status === 'UNDER_REVIEW'

/** "Recalculate the October 2026 payroll ..." when the month a paid off falls in was already calculated. */
function recalculateNote(run: PayrollRunForDate | null): string {
  return run && needsRecalculation(run) ? ` Recalculate the ${monthLabel(run.year, run.month)} payroll to apply it.` : ''
}

/** What one day is for an employee, as the paid-off date picker shows it. */
export interface PaidOffDay {
  date: IsoDate
  /** The employee's calendar for the day, paid offs and other extra offs included. */
  kind: 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'
  /** For a weekly off, what made it one: their weekly rule, a one-off grant, overtime before paid offs, or a paid off. */
  offSource: 'WEEKLY' | 'EXTRA' | 'OVERTIME' | 'PAID_OFF' | null
  /** A half working day under the weekly off rule. */
  isHalfWeeklyOff: boolean
  holidayName: string | null
  /** The attendance marked on the day, if any. */
  attendance: string | null
  /** A leave request covering the day that is approved or still waiting for a decision. */
  leave: { typeName: string; status: 'APPROVED' | 'PENDING'; halfDay: boolean } | null
  employed: boolean
  /** The payroll month holding the day is approved or locked. */
  payrollClosed: boolean
  /** This employee's paid off on the day, when one is scheduled. */
  paidOffId: string | null
  /** A paid off can be scheduled on the day; when not, `reason` says why. */
  selectable: boolean
  reason: string | null
}

interface PaidOffEmployeeRow {
  id: string
  name: string
  employee_code: string
  joining_date: IsoDate
  exit_date: IsoDate | null
  department_id: string | null
  location_id: string | null
  overtime_handling: string
}

async function findPaidOffEmployee(organizationId: string, employeeId: string, db: Queryable): Promise<PaidOffEmployeeRow> {
  const employee = await queryOne<PaidOffEmployeeRow>(
    db,
    `SELECT e.id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS name, e.employee_code, e.joining_date,
            e.exit_date, e.department_id, e.location_id, t.overtime_handling::text AS overtime_handling
       FROM employees e
       JOIN employee_types t ON t.id = e.employee_type_id
      WHERE e.id = $1 AND e.organization_id = $2`,
    [employeeId, organizationId],
  )
  if (!employee) throw ApiError.notFound('Employee')
  return employee
}

const ATTENDANCE_LABELS: Record<string, string> = {
  PRESENT: 'present',
  ABSENT: 'absent',
  HALF_DAY_LEAVE: 'a half day',
  ON_LEAVE: 'on leave',
  HOLIDAY: 'a holiday',
  WEEKLY_OFF: 'a weekly off',
}

/**
 * Every day from `from` to `to` for one employee, and whether a paid off can go
 * on it. A paid off needs a working day - not a weekly off or a holiday - while
 * they are employed, with no attendance marked and no leave approved or asked
 * for, in a payroll month not yet approved. Scheduling checks the same days,
 * so the picker and the server always agree.
 */
async function loadPaidOffDays(
  organizationId: string,
  employee: PaidOffEmployeeRow,
  from: IsoDate,
  to: IsoDate,
  db: Queryable,
): Promise<PaidOffDay[]> {
  const [calendar, extraOffs, attendance, leaves, closedRuns] = await Promise.all([
    buildCalendarContext(organizationId, from, to, db),
    calendarRepository.listExtraWeeklyOffsInRange(organizationId, from, to, db),
    queryRows<{ attendance_date: IsoDate; status: string }>(
      db,
      `SELECT attendance_date, status::text AS status FROM attendance
        WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3`,
      [employee.id, from, to],
    ),
    queryRows<{ from_date: IsoDate; to_date: IsoDate; status: 'APPROVED' | 'PENDING'; day_portion: string; type_name: string }>(
      db,
      `SELECT r.from_date, r.to_date, r.status::text AS status, r.day_portion::text AS day_portion, t.name AS type_name
         FROM leave_requests r
         JOIN leave_types t ON t.id = r.leave_type_id
        WHERE r.employee_id = $1 AND r.status IN ('APPROVED', 'PENDING') AND r.from_date <= $3 AND r.to_date >= $2`,
      [employee.id, from, to],
    ),
    queryRows<{ period_start: IsoDate; period_end: IsoDate }>(
      db,
      `SELECT period_start, period_end FROM payroll_runs
        WHERE organization_id = $1 AND status IN ('APPROVED', 'LOCKED') AND period_start <= $3 AND period_end >= $2`,
      [organizationId, from, to],
    ),
  ])

  const extraOffByDate = new Map(
    extraOffs.filter((off) => off.employee_id === employee.id).map((off) => [off.off_date, off]),
  )
  const attendanceByDate = new Map(attendance.map((row) => [row.attendance_date, row.status]))
  const scope = { departmentId: employee.department_id, locationId: employee.location_id, employeeId: employee.id }

  return datesBetween(from, to).map((date): PaidOffDay => {
    const calendarDay = calendar.dayFor(date, scope)
    const extraOff = extraOffByDate.get(date)
    const offSource: PaidOffDay['offSource'] =
      calendarDay.kind !== 'WEEKLY_OFF'
        ? null
        : extraOff?.source === 'PAID_OFF'
          ? 'PAID_OFF'
          : extraOff?.source === 'OVERTIME_CONVERSION'
            ? 'OVERTIME'
            : extraOff
              ? 'EXTRA'
              : 'WEEKLY'
    const marked = attendanceByDate.get(date) ?? null
    const leave = leaves.find((request) => date >= request.from_date && date <= request.to_date) ?? null
    const employed = date >= employee.joining_date && (employee.exit_date === null || date <= employee.exit_date)
    const payrollClosed = closedRuns.some((run) => date >= run.period_start && date <= run.period_end)

    let reason: string | null = null
    if (!employed) reason = date < employee.joining_date ? 'Before they joined' : 'After they left'
    else if (payrollClosed) reason = "This month's payroll is already approved"
    else if (offSource === 'PAID_OFF') reason = 'A paid off is already scheduled on this day'
    else if (calendarDay.kind === 'HOLIDAY') reason = `Holiday: ${calendarDay.holidayName ?? 'holiday'}`
    else if (calendarDay.kind === 'WEEKLY_OFF') reason = 'Already a weekly off'
    else if (marked && marked !== 'WEEKLY_OFF') reason = `Attendance already marked ${ATTENDANCE_LABELS[marked] ?? marked.toLowerCase()}`
    else if (leave?.status === 'APPROVED') reason = `On approved leave (${leave.type_name})`
    else if (leave) reason = `Leave asked for (${leave.type_name}) - approve or reject it first`

    return {
      date,
      kind: calendarDay.kind,
      offSource,
      isHalfWeeklyOff: calendarDay.isHalfWeeklyOff,
      holidayName: calendarDay.holidayName && calendarDay.kind === 'HOLIDAY' ? calendarDay.holidayName : null,
      attendance: marked,
      leave: leave ? { typeName: leave.type_name, status: leave.status, halfDay: leave.day_portion === 'HALF_DAY' } : null,
      employed,
      payrollClosed,
      paidOffId: offSource === 'PAID_OFF' ? (extraOff?.id ?? null) : null,
      selectable: reason === null,
      reason,
    }
  })
}

/** One employee's days over a stretch, for choosing a paid off date, with their balance. */
export async function paidOffCalendar(auth: AuthContext, query: PaidOffCalendarQuery) {
  await assertEmployeeInScope(auth, query.employeeId, viewScope(auth))
  const employee = await findPaidOffEmployee(auth.organizationId, query.employeeId, pool)
  const [days, balances] = await Promise.all([
    loadPaidOffDays(auth.organizationId, employee, query.from, query.to, pool),
    loadPaidOffBalances([employee.id]),
  ])
  return {
    employeeId: employee.id,
    employeeName: employee.name,
    employeeCode: employee.employee_code,
    available: balances.get(employee.id)?.available ?? 0,
    days,
  }
}

/**
 * The paid-off balance of each Supply employee the caller can see who has
 * earned one, or of the one employee asked for.
 */
export async function listPaidOffs(auth: AuthContext, query: PaidOffListQuery) {
  const clause = scopeClause(auth, viewScope(auth), 'e', 1)
  const params: unknown[] = [...clause.params]
  let filter = ''
  if (query.employeeId) {
    params.push(query.employeeId)
    filter = `AND e.id = $${params.length}`
  }

  const employees = await queryRows<{
    id: string
    employee_code: string
    first_name: string
    last_name: string | null
    department_name: string | null
  }>(
    pool,
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, d.name AS department_name
       FROM employees e
       JOIN employee_types t ON t.id = e.employee_type_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${clause.sql} AND t.overtime_handling = 'OFF_IN_LIEU' ${filter}
      ORDER BY e.employee_code`,
    params,
  )

  const [balances, closedRuns] = await Promise.all([
    loadPaidOffBalances(employees.map((employee) => employee.id)),
    queryRows<{ period_start: IsoDate; period_end: IsoDate }>(
      pool,
      `SELECT period_start, period_end FROM payroll_runs
        WHERE organization_id = $1 AND status IN ('APPROVED', 'LOCKED')`,
      [auth.organizationId],
    ),
  ])
  const inClosedPayroll = (date: IsoDate): boolean =>
    closedRuns.some((run) => date >= run.period_start && date <= run.period_end)

  return employees
    .map((employee) => {
      const balance = balances.get(employee.id) as PaidOffBalance
      return {
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        employeeName: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
        departmentName: employee.department_name,
        earned: balance.earned,
        convertedBefore: balance.convertedBefore,
        available: balance.available,
        // A paid off in an approved or locked payroll has been paid and stays.
        scheduled: balance.scheduled.map((off) => ({ ...off, locked: inClosedPayroll(off.date) })),
      }
    })
    .filter((row) => query.employeeId || row.earned > 0 || row.scheduled.length > 0 || row.convertedBefore > 0)
}

/**
 * Gives one of an employee's earned paid offs a date: one the picker offers
 * (loadPaidOffDays) - a working day while they are employed, with no
 * attendance marked and no leave approved or asked for, in a payroll month not
 * yet approved.
 */
export async function schedulePaidOff(auth: AuthContext, input: SchedulePaidOffInput, context: AuditContext) {
  const scope = manageScope(auth)
  const date = input.date

  return withTransaction((tx) =>
    // One at a time per employee, so two people cannot spend the same paid off.
    withAdvisoryLock(tx, `paid-offs:${input.employeeId}`, async () => {
      await assertCanManageEmployee(auth, input.employeeId, scope, tx)

      const employee = await findPaidOffEmployee(auth.organizationId, input.employeeId, tx)
      if (employee.overtime_handling !== 'OFF_IN_LIEU') {
        throw ApiError.businessRule(`${employee.name} is paid for overtime, so has no paid offs to schedule.`)
      }

      const balance = (await loadPaidOffBalances([employee.id], tx)).get(employee.id) as PaidOffBalance
      if (balance.available < 1) {
        throw ApiError.businessRule(
          `${employee.name} has no paid off left to schedule. Every ${HOURS_PER_PAID_OFF} hours of overtime in a week earns one.`,
        )
      }

      const shown = formatDayMonthYear(date)
      const [day] = await loadPaidOffDays(auth.organizationId, employee, date, date, tx)
      if (!day?.selectable) {
        throw ApiError.businessRule(`A paid off cannot go on ${shown} for ${employee.name}: ${day?.reason ?? 'not available'}. Choose another day.`)
      }

      const run = await payrollRunFor(auth.organizationId, date, tx)

      const row = await queryOne<{ id: string }>(
        tx,
        `INSERT INTO employee_extra_weekly_offs (organization_id, employee_id, off_date, source, granted_by)
         VALUES ($1, $2, $3, 'PAID_OFF', $4)
         ON CONFLICT (employee_id, off_date) DO NOTHING
         RETURNING id`,
        [auth.organizationId, employee.id, date, auth.userId],
      )
      if (!row) throw ApiError.businessRule(`${shown} is already a weekly off for ${employee.name}.`)

      await recordAudit(
        {
          ...context,
          action: 'WEEKLY_OFF_UPDATED',
          entityType: 'employee_extra_weekly_off',
          entityId: row.id,
          newValues: { paidOff: true, employeeId: employee.id, offDate: date },
        },
        tx,
      )

      return {
        result: { id: row.id, employeeId: employee.id, date, available: balance.available - 1 },
        message: `Paid off scheduled for ${employee.name} on ${shown}.${recalculateNote(run)}`,
      }
    }),
  )
}

/** Takes a scheduled paid off back into the balance, unless its payroll is approved. */
export async function removePaidOff(auth: AuthContext, id: string, context: AuditContext) {
  const scope = manageScope(auth)

  return withTransaction(async (tx) => {
    const off = await calendarRepository.findExtraWeeklyOff(id, auth.organizationId, tx)
    if (!off || off.source !== 'PAID_OFF') throw ApiError.notFound('Paid off')
    await assertCanManageEmployee(auth, off.employee_id, scope, tx)

    const run = await payrollRunFor(auth.organizationId, off.off_date, tx)
    if (isClosed(run)) {
      throw ApiError.businessRule(
        `Payroll for ${monthLabel(run!.year, run!.month)} is already ${run!.status.toLowerCase()} and has paid this off, so it can no longer be removed.`,
      )
    }

    await calendarRepository.deleteExtraWeeklyOff(id, auth.organizationId, tx)
    await recordAudit(
      {
        ...context,
        action: 'WEEKLY_OFF_UPDATED',
        entityType: 'employee_extra_weekly_off',
        entityId: id,
        oldValues: { paidOff: true, employeeId: off.employee_id, offDate: off.off_date },
      },
      tx,
    )

    return `Paid off on ${formatDayMonthYear(off.off_date)} removed - it is back in the balance.${recalculateNote(run)}`
  })
}
