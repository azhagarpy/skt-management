import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { pool, type Queryable } from '../../database/pool.js'
import type { IsoDate } from '../../utils/dates.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import { resolveScope, type EmployeeScope } from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './attendance.repository.js'
import { parseAttendanceSheet, type ImportStatus, type ParsedSheet } from './attendance-import.parser.js'
import type { AttendanceImportBody, ConflictMode } from './attendance-import.validation.js'

/**
 * Bulk attendance from a Face ID sheet.
 *
 * Scope follows the same rule as marking by hand: an admin (manage.all) may
 * update anyone in the sheet, a supervisor (manage.team) only the employees who
 * report to them - and not themselves. People outside that scope are reported
 * and skipped, never written and never an error, so one shared sheet works for
 * every supervisor.
 *
 * Preview and commit both run `buildPlan`. Commit re-runs it inside the
 * transaction, so what is written is decided against the database as it is at
 * that moment, not as it was when the preview was shown.
 */

const LIST_LIMIT = 100

type SkipReason = 'notEmployed' | 'locked' | 'protectedLeave'

interface PlannedWrite {
  employeeId: string
  employeeCode: string
  employeeName: string
  date: IsoDate
  status: ImportStatus
  previousStatus: string | null
  holidayId: string | null
}

interface Conflict extends PlannedWrite {
  previousStatus: string
}

interface Plan {
  sheet: ParsedSheet
  from: IsoDate
  to: IsoDate
  /** Cells whose day has no attendance yet. */
  creates: PlannedWrite[]
  /** Cells that would change an existing, different record. */
  conflicts: Conflict[]
  unchanged: number
  skipped: Record<SkipReason, number>
  unrecognisedCodes: number
  /** "Absent" cells that fell on a holiday or weekly off and were recorded as that day off. */
  absentAsDayOff: number
  unknownEmployees: { personId: string; name: string }[]
  outOfScope: { personId: string; name: string }[]
  byDate: Map<IsoDate, { create: number; conflict: number; unchanged: number }>
}

function manageScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.ATTENDANCE_MANAGE_ALL,
    team: PERMISSIONS.ATTENDANCE_MANAGE_TEAM,
  })
}

function fullName(first: string, last: string | null): string {
  return [first, last].filter(Boolean).join(' ')
}

/** Resolves the dates the user chose against those actually present in the sheet. */
function selectRange(sheet: ParsedSheet, body: AttendanceImportBody): { from: IsoDate; to: IsoDate } {
  const first = sheet.dates[0] as IsoDate
  const last = sheet.dates[sheet.dates.length - 1] as IsoDate
  const from = body.from ?? first
  const to = body.to ?? body.from ?? last
  if (to < from) throw ApiError.badRequest('The end date cannot be before the start date')
  if (!sheet.dates.some((date) => date >= from && date <= to)) {
    throw ApiError.badRequest(`The sheet has no attendance between ${from} and ${to}. It covers ${first} to ${last}.`)
  }
  return { from, to }
}

/** Exported for tests; callers outside this module use previewImport/commitImport. */
export async function buildPlan(
  auth: AuthContext,
  sheet: ParsedSheet,
  body: AttendanceImportBody,
  db: Queryable,
): Promise<Plan> {
  const scope = manageScope(auth)
  const { from, to } = selectRange(sheet, body)

  const entries = sheet.entries.filter((entry) => entry.date >= from && entry.date <= to)
  const codes = [...new Set(entries.map((entry) => entry.personId))]
  const employees = await repository.findEmployeesByCodes(auth.organizationId, codes, db)
  const byCode = new Map(employees.map((employee) => [employee.employee_code.trim().toUpperCase(), employee]))

  // A supervisor account with no employee record supervises nobody. Checked
  // explicitly: `null === null` would otherwise match every unsupervised employee.
  const supervisorId = auth.employeeId
  const canTouch = (employee: repository.ImportEmployeeRow): boolean =>
    scope === 'ALL' ||
    (supervisorId !== null && employee.supervisor_id === supervisorId && employee.id !== supervisorId)

  const inScopeIds = employees.filter(canTouch).map((employee) => employee.id)
  // Sequential: `db` may be a single transaction connection, which cannot run queries concurrently.
  const existing = await repository.listAttendanceForEmployees(inScopeIds, from, to, db)
  const calendar = await buildCalendarContext(auth.organizationId, from, to, db)
  const existingByKey = new Map(existing.map((row) => [`${row.employee_id}|${row.attendance_date}`, row]))

  const plan: Plan = {
    sheet,
    from,
    to,
    creates: [],
    conflicts: [],
    unchanged: 0,
    skipped: { notEmployed: 0, locked: 0, protectedLeave: 0 },
    unrecognisedCodes: sheet.unrecognised.filter((item) => item.date >= from && item.date <= to).length,
    absentAsDayOff: 0,
    unknownEmployees: [],
    outOfScope: [],
    byDate: new Map(),
  }

  const seenUnknown = new Set<string>()
  const seenOutOfScope = new Set<string>()
  const tally = (date: IsoDate) => {
    let row = plan.byDate.get(date)
    if (!row) {
      row = { create: 0, conflict: 0, unchanged: 0 }
      plan.byDate.set(date, row)
    }
    return row
  }

  for (const entry of entries) {
    const employee = byCode.get(entry.personId)
    if (!employee) {
      if (!seenUnknown.has(entry.personId)) {
        seenUnknown.add(entry.personId)
        plan.unknownEmployees.push({ personId: entry.personId, name: entry.personName })
      }
      continue
    }
    if (!canTouch(employee)) {
      if (!seenOutOfScope.has(entry.personId)) {
        seenOutOfScope.add(entry.personId)
        plan.outOfScope.push({ personId: entry.personId, name: entry.personName })
      }
      continue
    }

    // A date outside the employment window cannot carry attendance (same rule as marking by hand).
    if (entry.date < employee.joining_date || (employee.exit_date && entry.date > employee.exit_date)) {
      plan.skipped.notEmployed += 1
      continue
    }

    // The Face ID device knows nothing of the holiday calendar: it prints "A" for
    // anyone who did not badge in. Recorded as ABSENT, that would override the
    // calendar and forfeit the paid day, so on a day the calendar marks off it is
    // that day off. Present, half-day and explicit WO/H are the sheet's own word.
    let status: ImportStatus = entry.status
    let holidayId: string | null = null
    if (entry.status === 'ABSENT') {
      const day = calendar.dayFor(entry.date, {
        departmentId: employee.department_id,
        locationId: employee.location_id,
        employeeId: employee.id,
      })
      // An unpaid holiday stays absent: converting it would pay a day the calendar says is unpaid.
      if (day.kind === 'WEEKLY_OFF' || (day.kind === 'HOLIDAY' && day.holidayIsPaid)) {
        status = day.kind === 'HOLIDAY' ? 'HOLIDAY' : 'WEEKLY_OFF'
        holidayId = day.holidayId
        plan.absentAsDayOff += 1
      }
    } else if (entry.status === 'HOLIDAY') {
      holidayId = calendar.dayFor(entry.date, {
        departmentId: employee.department_id,
        locationId: employee.location_id,
        employeeId: employee.id,
      }).holidayId
    }

    const write: PlannedWrite = {
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      employeeName: fullName(employee.first_name, employee.last_name),
      date: entry.date,
      status,
      previousStatus: null,
      holidayId,
    }
    const current = existingByKey.get(`${employee.id}|${entry.date}`)

    if (!current) {
      plan.creates.push(write)
      tally(entry.date).create += 1
      continue
    }
    if (current.locked_by_payroll_run_id) {
      plan.skipped.locked += 1
      continue
    }
    if (current.status === status) {
      plan.unchanged += 1
      tally(entry.date).unchanged += 1
      continue
    }
    // The device reads "absent" for someone on approved leave; overriding would
    // silently sever the leave request, so those days are never touched.
    if (current.leave_request_id) {
      plan.skipped.protectedLeave += 1
      continue
    }
    plan.conflicts.push({ ...write, previousStatus: current.status })
    tally(entry.date).conflict += 1
  }

  return plan
}

function summarise(plan: Plan) {
  return {
    create: plan.creates.length,
    conflicts: plan.conflicts.length,
    unchanged: plan.unchanged,
    notEmployed: plan.skipped.notEmployed,
    locked: plan.skipped.locked,
    protectedLeave: plan.skipped.protectedLeave,
    unrecognisedCodes: plan.unrecognisedCodes,
    absentAsDayOff: plan.absentAsDayOff,
  }
}

async function readSheet(file: Express.Multer.File | undefined, body: AttendanceImportBody): Promise<ParsedSheet> {
  if (!file) throw ApiError.badRequest('Choose an .xlsx attendance sheet to upload')
  return parseAttendanceSheet(file.buffer, { fileName: file.originalname, year: body.year })
}

/** Dry run: what the sheet would do, changing nothing. */
export async function previewImport(auth: AuthContext, file: Express.Multer.File | undefined, body: AttendanceImportBody) {
  manageScope(auth)
  const sheet = await readSheet(file, body)
  const plan = await buildPlan(auth, sheet, body, pool)

  return {
    fileName: file?.originalname ?? '',
    format: sheet.format,
    sheetFrom: sheet.dates[0] as IsoDate,
    sheetTo: sheet.dates[sheet.dates.length - 1] as IsoDate,
    sheetDates: sheet.dates.length,
    peopleInSheet: sheet.people,
    selectedFrom: plan.from,
    selectedTo: plan.to,
    scope: manageScope(auth),
    summary: summarise(plan),
    byDate: [...plan.byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts })),
    conflicts: plan.conflicts.slice(0, LIST_LIMIT).map((conflict) => ({
      employeeCode: conflict.employeeCode,
      employeeName: conflict.employeeName,
      date: conflict.date,
      currentStatus: conflict.previousStatus,
      sheetStatus: conflict.status,
    })),
    unknownEmployees: { total: plan.unknownEmployees.length, items: plan.unknownEmployees.slice(0, LIST_LIMIT) },
    outOfScope: { total: plan.outOfScope.length, items: plan.outOfScope.slice(0, LIST_LIMIT) },
    duplicates: sheet.duplicates,
  }
}

/**
 * Applies the sheet. When it would change days that already carry attendance the
 * caller must say what to do (`conflictMode`); the server refuses to guess, so a
 * client that skips the question cannot overwrite anything by accident.
 */
export async function commitImport(
  auth: AuthContext,
  file: Express.Multer.File | undefined,
  body: AttendanceImportBody,
  context: AuditContext,
) {
  manageScope(auth)
  const sheet = await readSheet(file, body)

  return withTransaction(async (tx) => {
    const plan = await buildPlan(auth, sheet, body, tx)
    const mode: ConflictMode | undefined = body.conflictMode

    if (plan.conflicts.length > 0 && !mode) {
      throw ApiError.conflict(
        `${plan.conflicts.length} day(s) already have different attendance. Choose whether to override them or keep the existing values.`,
        [{ message: 'conflictMode is required', conflicts: plan.conflicts.length }],
      )
    }

    const overrides = mode === 'OVERRIDE' ? plan.conflicts : []
    const writes = [...plan.creates, ...overrides]
    const reason = `Imported from Face ID sheet${file?.originalname ? ` (${file.originalname})` : ''}`

    const written = await repository.upsertImportedBatch(
      auth.organizationId,
      writes.map((write) => ({
        employeeId: write.employeeId,
        attendanceDate: write.date,
        status: write.status,
        previousStatus: write.previousStatus,
        holidayId: write.holidayId,
      })),
      reason,
      auth.userId,
      tx,
    )

    const result = {
      created: plan.creates.length,
      overridden: overrides.length,
      keptExisting: mode === 'KEEP' ? plan.conflicts.length : 0,
      unchanged: plan.unchanged,
      skipped: {
        notEmployed: plan.skipped.notEmployed,
        locked: plan.skipped.locked,
        protectedLeave: plan.skipped.protectedLeave,
        unrecognisedCodes: plan.unrecognisedCodes,
        unknownEmployees: plan.unknownEmployees.length,
        outOfScope: plan.outOfScope.length,
      },
      from: plan.from,
      to: plan.to,
      written,
    }

    await recordAudit(
      {
        ...context,
        action: 'ATTENDANCE_IMPORTED',
        entityType: 'attendance',
        entityId: null,
        newValues: { fileName: file?.originalname, format: sheet.format, conflictMode: mode ?? null, ...result },
      },
      tx,
    )

    return result
  })
}
