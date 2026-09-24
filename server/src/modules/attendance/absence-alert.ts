import { pool, queryRows, type Queryable } from '../../database/pool.js'
import { logger } from '../../utils/logger.js'
import { notifyRole } from '../notifications/notifications.service.js'
import type { IsoDate } from '../../utils/dates.js'

/** Consecutive absent days before an administrator and supervisor are told. */
export const ABSENCE_STREAK_DAYS = 7

type Status = 'PRESENT' | 'ABSENT' | 'ON_LEAVE' | 'HALF_DAY_LEAVE' | 'HOLIDAY' | 'WEEKLY_OFF'

export interface AttendanceDay {
  date: IsoDate
  status: Status
}

export interface AbsenceRun {
  from: IsoDate
  to: IsoDate
  days: number
}

/**
 * The run of unexplained absence an employee's attendance ends on.
 *
 * Only ABSENT counts towards the total. A holiday or weekly off inside the run
 * neither counts nor ends it - the person still has not turned up, and a
 * Sunday in the middle should not reset the count to zero. Anything else
 * (present, or leave that was actually applied for) ends the run, because the
 * employee is accounted for on that day.
 *
 * Reads newest-first so it can stop as soon as the run is broken.
 */
export function trailingAbsenceRun(days: AttendanceDay[]): AbsenceRun | null {
  const ordered = [...days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  let count = 0
  let from: IsoDate | null = null
  let to: IsoDate | null = null

  for (const day of ordered) {
    if (day.status === 'ABSENT') {
      count += 1
      from = day.date
      if (to === null) to = day.date
      continue
    }
    // Neutral days keep the run alive but only once it has started: a trailing
    // holiday is not itself an absence.
    if (day.status === 'HOLIDAY' || day.status === 'WEEKLY_OFF') {
      if (count > 0) from = day.date
      continue
    }
    break
  }

  if (count === 0 || from === null || to === null) return null
  return { from, to, days: count }
}

/**
 * Whether this run has already been reported.
 *
 * Keyed on the day the run starts, which is stable while the run grows, so an
 * employee absent for three more days does not raise three more alerts. A new
 * run after the employee returns starts on a different day and does alert.
 */
async function alreadyAlerted(
  organizationId: string,
  employeeId: string,
  runFrom: IsoDate,
  db: Queryable,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    db,
    `SELECT id FROM notifications
      WHERE organization_id = $1
        AND type = 'ABSENCE_STREAK'
        AND metadata ->> 'employeeId' = $2
        AND metadata ->> 'runFrom' = $3
      LIMIT 1`,
    [organizationId, employeeId, runFrom],
  )
  return rows.length > 0
}

interface EmployeeRow {
  id: string
  employee_code: string
  first_name: string
  last_name: string | null
}

/**
 * Raises one notification per employee who has now been absent for
 * ABSENCE_STREAK_DAYS days in a row, to every administrator and supervisor.
 *
 * notifyUser funnels every notification through the WhatsApp dispatcher, so
 * enabling the ABSENCE_STREAK scenario is all that is needed for the message
 * to go out on WhatsApp as well as in the app.
 *
 * Never throws: attendance must still be saved if the alert cannot be sent.
 */
export async function checkAbsenceStreaks(
  organizationId: string,
  employeeIds: string[],
  db: Queryable = pool,
): Promise<number> {
  if (employeeIds.length === 0) return 0

  try {
    const employees = await queryRows<EmployeeRow>(
      db,
      `SELECT id, employee_code, first_name, last_name
         FROM employees
        WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND employment_status = 'ACTIVE'`,
      [organizationId, employeeIds],
    )
    if (employees.length === 0) return 0

    // A window wide enough to hold a qualifying run even when holidays and
    // weekly offs pad it out, without scanning the employee's whole history.
    const rows = await queryRows<{ employee_id: string; attendance_date: string; status: Status }>(
      db,
      `SELECT employee_id, attendance_date::text, status
         FROM attendance
        WHERE organization_id = $1
          AND employee_id = ANY($2::uuid[])
          AND attendance_date >= current_date - INTERVAL '90 days'
        ORDER BY employee_id, attendance_date`,
      [organizationId, employees.map((e) => e.id)],
    )

    const byEmployee = new Map<string, AttendanceDay[]>()
    for (const row of rows) {
      const list = byEmployee.get(row.employee_id) ?? []
      list.push({ date: row.attendance_date as IsoDate, status: row.status })
      byEmployee.set(row.employee_id, list)
    }

    let raised = 0
    for (const employee of employees) {
      const run = trailingAbsenceRun(byEmployee.get(employee.id) ?? [])
      if (!run || run.days < ABSENCE_STREAK_DAYS) continue
      if (await alreadyAlerted(organizationId, employee.id, run.from, db)) continue

      const name = [employee.first_name, employee.last_name].filter(Boolean).join(' ')
      await notifyRole(
        organizationId,
        ['SUPER_ADMIN', 'SUPERVISOR'],
        {
          organizationId,
          type: 'ABSENCE_STREAK',
          title: `${name} absent ${run.days} days`,
          body: `${name} (${employee.employee_code}) has been absent for ${run.days} consecutive days, from ${run.from} to ${run.to}, without approved leave.`,
          link: `/attendance?employee=${employee.id}`,
          metadata: {
            employeeId: employee.id,
            employeeCode: employee.employee_code,
            runFrom: run.from,
            runTo: run.to,
            days: run.days,
          },
        },
        db,
      )
      raised += 1
    }
    return raised
  } catch (error) {
    logger.error({ err: error, organizationId }, 'Absence streak check failed')
    return 0
  }
}
