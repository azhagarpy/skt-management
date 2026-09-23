import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import type { IsoDate } from '../../utils/dates.js'
import type { ScopeClause } from '../employees/employee-access.js'

export interface AttendanceRow {
  id: string
  organization_id: string
  employee_id: string
  attendance_date: IsoDate
  status: string
  leave_request_id: string | null
  leave_type_id: string | null
  holiday_id: string | null
  shift_id: string | null
  source: string
  remarks: string | null
  locked_by_payroll_run_id: string | null
  created_at: Date
  updated_at: Date
}

export interface AttendanceWithEmployeeRow extends AttendanceRow {
  employee_code: string
  first_name: string
  last_name: string | null
  department_name: string | null
  leave_type_name: string | null
  shift_code: string | null
  shift_name: string | null
}

export interface DailySheetRow {
  employee_id: string
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  department_id: string | null
  department_name: string | null
  designation_name: string | null
  location_id: string | null
  supervisor_id: string | null
  supervisor_name: string | null
  joining_date: IsoDate
  exit_date: IsoDate | null
  attendance_id: string | null
  status: string | null
  leave_type_id: string | null
  leave_type_name: string | null
  shift_id: string | null
  shift_code: string | null
  shift_name: string | null
  remarks: string | null
  locked_by_payroll_run_id: string | null
}

/**
 * The daily marking sheet.
 *
 * Every employee in scope who was employed on that date is returned, joined to
 * their attendance row if one exists, so the UI can show "not yet marked" rows
 * alongside marked ones.
 */
export async function dailySheet(
  scope: ScopeClause,
  date: IsoDate,
  filters: { departmentId?: string; supervisorId?: string; locationId?: string; search?: string; status?: string; unmarkedOnly?: boolean },
  db: Queryable = pool,
): Promise<DailySheetRow[]> {
  const params: unknown[] = [...scope.params]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const dateIndex = push(date)
  const conditions = [
    `(${scope.sql})`,
    // Employed on the date in question.
    `e.joining_date <= $${dateIndex}`,
    `(e.exit_date IS NULL OR e.exit_date >= $${dateIndex})`,
    `e.employment_status <> 'INACTIVE'`,
  ]

  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.supervisorId) conditions.push(`e.supervisor_id = $${push(filters.supervisorId)}`)
  if (filters.locationId) conditions.push(`e.location_id = $${push(filters.locationId)}`)
  if (filters.search) {
    const index = push(`%${filters.search}%`)
    conditions.push(`(e.employee_code ILIKE $${index} OR e.first_name ILIKE $${index} OR e.last_name ILIKE $${index})`)
  }
  if (filters.status) conditions.push(`a.status = $${push(filters.status)}`)
  if (filters.unmarkedOnly) conditions.push('a.id IS NULL')

  return queryRows<DailySheetRow>(
    db,
    `SELECT e.id AS employee_id,
            e.employee_code,
            e.first_name,
            e.middle_name,
            e.last_name,
            e.department_id,
            d.name AS department_name,
            g.name AS designation_name,
            e.location_id,
            e.supervisor_id,
            CASE WHEN s.id IS NULL THEN NULL
                 ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name,
            e.joining_date,
            e.exit_date,
            a.id AS attendance_id,
            a.status::text AS status,
            a.leave_type_id,
            lt.name AS leave_type_name,
            a.shift_id,
            sh.code AS shift_code,
            sh.name AS shift_name,
            a.remarks,
            a.locked_by_payroll_run_id
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.attendance_date = $${dateIndex}
       LEFT JOIN departments  d ON d.id = e.department_id
       LEFT JOIN designations g ON g.id = e.designation_id
       LEFT JOIN employees    s ON s.id = e.supervisor_id
       LEFT JOIN leave_types  lt ON lt.id = a.leave_type_id
       LEFT JOIN shifts       sh ON sh.id = a.shift_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.employee_code ASC`,
    params,
  )
}

export async function listAttendance(
  scope: ScopeClause,
  filters: { from: IsoDate; to: IsoDate; employeeId?: string; departmentId?: string; supervisorId?: string; status?: string },
  db: Queryable = pool,
): Promise<AttendanceWithEmployeeRow[]> {
  const params: unknown[] = [...scope.params]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const conditions = [`(${scope.sql})`, `a.attendance_date >= $${push(filters.from)}`, `a.attendance_date <= $${push(filters.to)}`]

  if (filters.employeeId) conditions.push(`a.employee_id = $${push(filters.employeeId)}`)
  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.supervisorId) conditions.push(`e.supervisor_id = $${push(filters.supervisorId)}`)
  if (filters.status) conditions.push(`a.status = $${push(filters.status)}`)

  return queryRows<AttendanceWithEmployeeRow>(
    db,
    `SELECT a.*,
            e.employee_code,
            e.first_name,
            e.last_name,
            d.name  AS department_name,
            lt.name AS leave_type_name,
            sh.code AS shift_code,
            sh.name AS shift_name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.attendance_date DESC, e.employee_code ASC`,
    params,
  )
}

export async function findAttendanceById(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<AttendanceRow | null> {
  return queryOne<AttendanceRow>(db, 'SELECT * FROM attendance WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function findAttendanceForDate(
  employeeId: string,
  date: IsoDate,
  db: Queryable = pool,
): Promise<AttendanceRow | null> {
  return queryOne<AttendanceRow>(db, 'SELECT * FROM attendance WHERE employee_id = $1 AND attendance_date = $2', [
    employeeId,
    date,
  ])
}

/**
 * Inserts or updates one attendance record.
 *
 * The unique (employee_id, attendance_date) constraint is what actually enforces
 * "one record per employee per date"; the ON CONFLICT clause turns a repeat mark
 * into an update rather than an error.
 */
export async function upsertAttendance(
  values: {
    organizationId: string
    employeeId: string
    attendanceDate: IsoDate
    status: string
    leaveRequestId?: string | null
    leaveTypeId?: string | null
    holidayId?: string | null
    shiftId?: string | null
    source: string
    remarks?: string | null
    userId: string | null
  },
  db: Queryable = pool,
): Promise<AttendanceRow> {
  const row = await queryOne<AttendanceRow>(
    db,
    `INSERT INTO attendance
       (organization_id, employee_id, attendance_date, status, leave_request_id, leave_type_id,
        holiday_id, shift_id, source, remarks, marked_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     ON CONFLICT (employee_id, attendance_date) DO UPDATE
       SET status = EXCLUDED.status,
           leave_request_id = EXCLUDED.leave_request_id,
           leave_type_id = EXCLUDED.leave_type_id,
           holiday_id = EXCLUDED.holiday_id,
           shift_id = EXCLUDED.shift_id,
           source = EXCLUDED.source,
           remarks = EXCLUDED.remarks,
           updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      values.organizationId,
      values.employeeId,
      values.attendanceDate,
      values.status,
      values.leaveRequestId ?? null,
      values.leaveTypeId ?? null,
      values.holidayId ?? null,
      values.shiftId ?? null,
      values.source,
      values.remarks ?? null,
      values.userId,
    ],
  )
  return row as AttendanceRow
}

export async function recordAttendanceHistory(
  values: {
    attendanceId: string
    organizationId: string
    employeeId: string
    attendanceDate: IsoDate
    previousStatus: string | null
    newStatus: string
    reason?: string | null
    changedBy: string | null
  },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO attendance_history
       (attendance_id, organization_id, employee_id, attendance_date, previous_status, new_status, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      values.attendanceId,
      values.organizationId,
      values.employeeId,
      values.attendanceDate,
      values.previousStatus,
      values.newStatus,
      values.reason ?? null,
      values.changedBy,
    ],
  )
}

export async function listAttendanceHistory(
  attendanceId: string,
  db: Queryable = pool,
): Promise<
  { id: string; previous_status: string | null; new_status: string; reason: string | null; created_at: Date }[]
> {
  return queryRows(
    db,
    `SELECT id, previous_status, new_status, reason, created_at
       FROM attendance_history WHERE attendance_id = $1 ORDER BY created_at DESC`,
    [attendanceId],
  )
}

/** All attendance for a set of employees over a window, keyed for in-memory use. */
export async function listAttendanceForEmployees(
  employeeIds: string[],
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<AttendanceRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<AttendanceRow>(
    db,
    `SELECT * FROM attendance
      WHERE employee_id = ANY($1::uuid[]) AND attendance_date BETWEEN $2 AND $3
      ORDER BY employee_id, attendance_date`,
    [employeeIds, from, to],
  )
}

export interface StatusCountRow {
  status: string
  count: string
}

export async function countByStatus(
  scope: ScopeClause,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<StatusCountRow[]> {
  const params = [...scope.params, from, to]
  return queryRows<StatusCountRow>(
    db,
    `SELECT a.status::text AS status, count(*)::text AS count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE (${scope.sql})
        AND a.attendance_date >= $${scope.params.length + 1}
        AND a.attendance_date <= $${scope.params.length + 2}
      GROUP BY a.status`,
    params,
  )
}

/** Marks the attendance consumed by a payroll run so later edits are refused. */
export async function lockAttendanceForPeriod(
  organizationId: string,
  payrollRunId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<number> {
  const result = await db.query(
    `UPDATE attendance
        SET locked_by_payroll_run_id = $2
      WHERE organization_id = $1 AND attendance_date BETWEEN $3 AND $4`,
    [organizationId, payrollRunId, from, to],
  )
  return result.rowCount ?? 0
}

export async function unlockAttendanceForRun(
  payrollRunId: string,
  db: Queryable = pool,
): Promise<number> {
  const result = await db.query(
    'UPDATE attendance SET locked_by_payroll_run_id = NULL WHERE locked_by_payroll_run_id = $1',
    [payrollRunId],
  )
  return result.rowCount ?? 0
}

export interface ImportEmployeeRow {
  id: string
  employee_code: string
  first_name: string
  last_name: string | null
  supervisor_id: string | null
  department_id: string | null
  location_id: string | null
  joining_date: IsoDate
  exit_date: IsoDate | null
}

/** Resolves sheet Person Ids to employees. `codes` must already be upper-cased. */
export async function findEmployeesByCodes(
  organizationId: string,
  codes: string[],
  db: Queryable = pool,
): Promise<ImportEmployeeRow[]> {
  if (codes.length === 0) return []
  return queryRows<ImportEmployeeRow>(
    db,
    `SELECT id, employee_code, first_name, last_name, supervisor_id, department_id, location_id,
            joining_date, exit_date
       FROM employees
      WHERE organization_id = $1 AND upper(trim(employee_code)) = ANY($2::text[])`,
    [organizationId, codes],
  )
}

export interface ImportedAttendanceValues {
  employeeId: string
  attendanceDate: IsoDate
  status: string
  previousStatus: string | null
  /** Set when the day is a configured holiday, so the record points at it. */
  holidayId?: string | null
}

const IMPORT_CHUNK_SIZE = 1000

/**
 * Writes imported attendance and its history in set-based batches.
 *
 * An override clears the leave link and re-points the holiday link (the sheet is
 * now the source of truth for that day) but keeps any shift already assigned, since sheets carry
 * none. The locked guard on the conflict branch is a backstop: the caller has
 * already filtered locked rows, this only matters if payroll locks mid-import.
 */
export async function upsertImportedBatch(
  organizationId: string,
  rows: ImportedAttendanceValues[],
  reason: string,
  userId: string | null,
  db: Queryable = pool,
): Promise<number> {
  let written = 0

  for (let start = 0; start < rows.length; start += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + IMPORT_CHUNK_SIZE)
    const saved = await queryRows<{ id: string; employee_id: string; attendance_date: IsoDate; status: string }>(
      db,
      `INSERT INTO attendance
         (organization_id, employee_id, attendance_date, status, holiday_id, source, remarks, marked_by, updated_by)
       SELECT $1, t.employee_id, t.attendance_date, t.status::attendance_status, t.holiday_id, 'IMPORT', $3, $2, $2
         FROM unnest($4::uuid[], $5::date[], $6::text[], $7::uuid[]) AS t(employee_id, attendance_date, status, holiday_id)
       ON CONFLICT (employee_id, attendance_date) DO UPDATE
         SET status = EXCLUDED.status,
             leave_request_id = NULL,
             leave_type_id = NULL,
             holiday_id = EXCLUDED.holiday_id,
             source = 'IMPORT',
             remarks = EXCLUDED.remarks,
             updated_by = EXCLUDED.updated_by
         WHERE attendance.locked_by_payroll_run_id IS NULL
       RETURNING id, employee_id, attendance_date, status::text AS status`,
      [
        organizationId,
        userId,
        'Imported from Face ID sheet',
        chunk.map((row) => row.employeeId),
        chunk.map((row) => row.attendanceDate),
        chunk.map((row) => row.status),
        chunk.map((row) => row.holidayId ?? null),
      ],
    )

    const previous = new Map(chunk.map((row) => [`${row.employeeId}|${row.attendanceDate}`, row.previousStatus]))
    await db.query(
      `INSERT INTO attendance_history
         (attendance_id, organization_id, employee_id, attendance_date, previous_status, new_status, reason, changed_by)
       SELECT t.attendance_id, $1, t.employee_id, t.attendance_date,
              NULLIF(t.previous_status, '')::attendance_status, t.new_status::attendance_status, $2, $3
         FROM unnest($4::uuid[], $5::uuid[], $6::date[], $7::text[], $8::text[])
              AS t(attendance_id, employee_id, attendance_date, previous_status, new_status)`,
      [
        organizationId,
        reason,
        userId,
        saved.map((row) => row.id),
        saved.map((row) => row.employee_id),
        saved.map((row) => row.attendance_date),
        saved.map((row) => previous.get(`${row.employee_id}|${row.attendance_date}`) ?? ''),
        saved.map((row) => row.status),
      ],
    )
    written += saved.length
  }

  return written
}

export interface CalendarDerivedRow {
  id: string
  employee_id: string
  employee_code: string
  attendance_date: IsoDate
  status: string
  department_id: string | null
  location_id: string | null
}

/**
 * Holiday / weekly-off records that came from the calendar rather than from a
 * person's decision, so "Apply calendar" can check them against the calendar as
 * it stands now.
 *
 *  - HOLIDAY written by the calendar rule, or by a Face ID import (which records
 *    an "absent" on a paid holiday as the holiday).
 *  - WEEKLY_OFF written by the calendar rule only. An imported WEEKLY_OFF is the
 *    device's own "WO" and is never second-guessed.
 *
 * Manually and bulk-marked days, approved leave and payroll-locked days are left
 * out: those are deliberate and are not the calendar's to take back.
 */
export async function listCalendarDerivedRecords(
  scope: ScopeClause,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<CalendarDerivedRow[]> {
  const params = [...scope.params, from, to]
  return queryRows<CalendarDerivedRow>(
    db,
    `SELECT a.id, a.employee_id, e.employee_code, a.attendance_date, a.status::text AS status,
            e.department_id, e.location_id
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE (${scope.sql})
        AND a.attendance_date >= $${scope.params.length + 1}
        AND a.attendance_date <= $${scope.params.length + 2}
        AND a.locked_by_payroll_run_id IS NULL
        AND a.leave_request_id IS NULL
        AND ((a.status = 'HOLIDAY' AND a.source IN ('HOLIDAY_RULE', 'IMPORT'))
          OR (a.status = 'WEEKLY_OFF' AND a.source = 'WEEKLY_OFF_RULE'))`,
    params,
  )
}

/** Un-marks days by removing their records. The locked guard is a backstop only. */
export async function deleteAttendanceByIds(ids: string[], db: Queryable = pool): Promise<number> {
  if (ids.length === 0) return 0
  const result = await db.query(
    'DELETE FROM attendance WHERE id = ANY($1::uuid[]) AND locked_by_payroll_run_id IS NULL',
    [ids],
  )
  return result.rowCount ?? 0
}

/**
 * The dates in a window on which one employee was on full-day leave.
 *
 * The sandwich rule in leave.service.ts needs to know whether the day either
 * side of a holiday was taken as leave, and that leave usually belongs to a
 * different request than the one being counted. A half day is deliberately not
 * included: the employee worked part of it, so it does not bracket anything.
 */
export async function findFullDayLeaveDates(
  employeeId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<IsoDate[]> {
  const rows = await queryRows<{ attendance_date: IsoDate }>(
    db,
    `SELECT attendance_date FROM attendance
      WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3 AND status = 'ON_LEAVE'
      ORDER BY attendance_date`,
    [employeeId, from, to],
  )
  return rows.map((row) => row.attendance_date)
}

/**
 * Every attendance record written by one leave request.
 *
 * Cancelling a leave has to undo exactly the days it wrote, and the sandwich
 * rule means those days can fall outside the request's own from/to range.
 */
export async function findAttendanceForLeaveRequest(
  leaveRequestId: string,
  db: Queryable = pool,
): Promise<AttendanceRow[]> {
  return queryRows<AttendanceRow>(
    db,
    'SELECT * FROM attendance WHERE leave_request_id = $1 ORDER BY attendance_date',
    [leaveRequestId],
  )
}
