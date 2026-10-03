import { ApiError } from '../../utils/api-error.js'
import { countDaysBetween, datesBetween, type IsoDate } from '../../utils/dates.js'
import * as attendanceRepository from '../attendance/attendance.repository.js'
import { calendarStatusFor, STATUS_CODES, type CalendarStatus } from '../attendance/attendance.service.js'
import { buildCalendarContext, type DayInfo } from '../calendar/calendar.service.js'
import { attendanceDayKey } from './report-definitions.js'
import type { ReportRow } from './report-amounts.js'

/**
 * The Monthly Attendance report's day columns: each employee's status on each
 * day of the period, as the attendance calendar shows it - what was marked,
 * else what the calendar makes the day - plus the totals of each. The
 * Attendance Summary report has the totals alone, over a longer period.
 */

/** The longest period the Attendance Summary covers: two years and a day. */
const SUMMARY_MAX_DAYS = 732

/** A day as the report shows it: a calendar status, or a weekly off that is a paid off. */
export type AttendanceDayStatus = CalendarStatus | 'PAID_OFF'

const CODES: Record<AttendanceDayStatus, string> = {
  ...(STATUS_CODES as Record<Exclude<AttendanceDayStatus, 'PAID_OFF' | 'UNMARKED'>, string>),
  PAID_OFF: 'PO',
  UNMARKED: 'NM',
}

const TOTAL_KEY: Record<AttendanceDayStatus, string> = {
  PRESENT: 'present_days',
  ABSENT: 'absent_days',
  ON_LEAVE: 'leave_days',
  HALF_DAY_LEAVE: 'half_days',
  HOLIDAY: 'holiday_days',
  WEEKLY_OFF: 'weekly_off_days',
  PAID_OFF: 'paid_off_days',
  UNMARKED: 'unmarked_days',
}

/** The status of one employed day. A weekly off on a paid off date is shown as the paid off it is. */
export function attendanceDayStatus(
  recordStatus: string | null | undefined,
  day: Pick<DayInfo, 'kind' | 'isPaidOff'>,
): AttendanceDayStatus {
  const status = calendarStatusFor(recordStatus, day.kind)
  return status === 'WEEKLY_OFF' && day.isPaidOff ? 'PAID_OFF' : status
}

/**
 * One employee's row: the count of each status over the days they were
 * employed and, with `withDays`, a code for each of those days and a blank for
 * the days they were not.
 */
export function attendanceRowCells(
  dates: IsoDate[],
  employment: { joiningDate: IsoDate; exitDate: IsoDate | null },
  statusOn: (date: IsoDate) => AttendanceDayStatus,
  withDays = true,
): Record<string, string | number | null> {
  const cells: Record<string, string | number | null> = {}
  for (const key of Object.values(TOTAL_KEY)) cells[key] = 0

  for (const date of dates) {
    const employed = date >= employment.joiningDate && (employment.exitDate === null || date <= employment.exitDate)
    if (!employed) {
      if (withDays) cells[attendanceDayKey(date)] = null
      continue
    }
    const status = statusOn(date)
    if (withDays) cells[attendanceDayKey(date)] = CODES[status]
    cells[TOTAL_KEY[status]] = Number(cells[TOTAL_KEY[status]]) + 1
  }
  return cells
}

/** The working fields the SQL selects, dropped once the days are filled in. */
const WORKING_FIELDS = ['employee_id', 'department_id', 'location_id', 'joining_date', 'exit_date']

/** Monthly Attendance: each day's code, and the totals. */
export function addAttendanceDays(
  organizationId: string,
  rows: ReportRow[],
  filters: { from?: IsoDate; to?: IsoDate },
): Promise<ReportRow[]> {
  return addAttendance(organizationId, rows, filters, true)
}

/** Attendance Summary: the totals alone. */
export function addAttendanceTotals(
  organizationId: string,
  rows: ReportRow[],
  filters: { from?: IsoDate; to?: IsoDate },
): Promise<ReportRow[]> {
  const { from, to } = filters
  if (from && to && (to < from || countDaysBetween(from, to) > SUMMARY_MAX_DAYS)) {
    throw ApiError.badRequest('Choose a period of up to two years, ending after it starts.')
  }
  return addAttendance(organizationId, rows, filters, false)
}

async function addAttendance(
  organizationId: string,
  rows: ReportRow[],
  filters: { from?: IsoDate; to?: IsoDate },
  withDays: boolean,
): Promise<ReportRow[]> {
  const { from, to } = filters
  if (rows.length === 0 || !from || !to) return rows

  const employeeIds = rows.map((row) => String(row.employee_id))
  const [calendar, records] = await Promise.all([
    buildCalendarContext(organizationId, from, to),
    attendanceRepository.listAttendanceForEmployees(employeeIds, from, to),
  ])
  const recordStatus = new Map(records.map((record) => [`${record.employee_id}|${record.attendance_date}`, record.status]))
  const dates = datesBetween(from, to)

  return rows.map((row) => {
    const employeeId = String(row.employee_id)
    const scope = {
      departmentId: (row.department_id as string | null) ?? null,
      locationId: (row.location_id as string | null) ?? null,
      employeeId,
    }
    const cells = attendanceRowCells(
      dates,
      { joiningDate: row.joining_date as IsoDate, exitDate: (row.exit_date as IsoDate | null) ?? null },
      (date) => attendanceDayStatus(recordStatus.get(`${employeeId}|${date}`), calendar.dayFor(date, scope)),
      withDays,
    )

    const visible: ReportRow = { ...row, ...cells }
    for (const key of WORKING_FIELDS) delete visible[key]
    return visible
  })
}
