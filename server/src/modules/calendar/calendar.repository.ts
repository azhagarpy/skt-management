import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { buildUpdate } from '../organization/organization.repository.js'
import type { IsoDate, WeekdayName } from '../../utils/dates.js'

export interface WeeklyOffRuleRow {
  id: string
  organization_id: string
  department_id: string | null
  location_id: string | null
  name: string
  description: string | null
  effective_from: IsoDate
  effective_to: IsoDate | null
  priority: number
  is_active: boolean
}

export interface WeeklyOffRuleDayRow {
  id: string
  rule_id: string
  weekday: WeekdayName
  occurrences: number[] | null
  include_last: boolean
  is_half_day: boolean
}

export interface WeeklyOffRuleWithDays extends WeeklyOffRuleRow {
  days: WeeklyOffRuleDayRow[]
}

export interface HolidayRow {
  id: string
  organization_id: string
  calendar_id: string | null
  name: string
  holiday_date: IsoDate
  description: string | null
  is_optional: boolean
  is_paid: boolean
  /** Whoever works this holiday earns one extra day's pay on top of the paid holiday. */
  extra_pay_if_worked: boolean
  calendar_name?: string | null
}

export interface HolidayCalendarRow {
  id: string
  organization_id: string
  name: string
  year: number
  location_id: string | null
  is_default: boolean
  is_active: boolean
  holiday_count?: string
}

export interface EmployeeWeeklyOffAssignmentRow {
  id: string
  organization_id: string
  employee_id: string
  weekday: WeekdayName
  effective_from: IsoDate
  effective_to: IsoDate | null
  created_by: string | null
  created_at: Date
}

export interface EmployeeExtraWeeklyOffRow {
  id: string
  organization_id: string
  employee_id: string
  off_date: IsoDate
  source: string
  granted_by: string | null
  created_at: Date
}

export interface ShiftRow {
  id: string
  organization_id: string
  name: string
  code: string
  start_time: string | null
  end_time: string | null
  break_minutes: number
  is_night_shift: boolean
  is_active: boolean
}

// ---------------------------------------------------------------------------
// Weekly off rules
// ---------------------------------------------------------------------------

export async function listWeeklyOffRules(
  organizationId: string,
  filters: { activeOnly?: boolean } = {},
  db: Queryable = pool,
): Promise<WeeklyOffRuleWithDays[]> {
  const conditions = ['r.organization_id = $1']
  if (filters.activeOnly) conditions.push('r.is_active')

  const rules = await queryRows<WeeklyOffRuleRow>(
    db,
    `SELECT r.* FROM weekly_off_rules r
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.priority DESC, r.effective_from DESC`,
    [organizationId],
  )
  if (rules.length === 0) return []

  const days = await queryRows<WeeklyOffRuleDayRow>(
    db,
    'SELECT * FROM weekly_off_rule_days WHERE rule_id = ANY($1::uuid[])',
    [rules.map((rule) => rule.id)],
  )

  const daysByRule = new Map<string, WeeklyOffRuleDayRow[]>()
  for (const day of days) {
    const list = daysByRule.get(day.rule_id) ?? []
    list.push(day)
    daysByRule.set(day.rule_id, list)
  }

  return rules.map((rule) => ({ ...rule, days: daysByRule.get(rule.id) ?? [] }))
}

export async function findWeeklyOffRule(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<WeeklyOffRuleWithDays | null> {
  const rule = await queryOne<WeeklyOffRuleRow>(
    db,
    'SELECT * FROM weekly_off_rules WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
  if (!rule) return null
  const days = await queryRows<WeeklyOffRuleDayRow>(db, 'SELECT * FROM weekly_off_rule_days WHERE rule_id = $1', [id])
  return { ...rule, days }
}

export async function insertWeeklyOffRule(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<WeeklyOffRuleRow> {
  const row = await queryOne<WeeklyOffRuleRow>(
    db,
    `INSERT INTO weekly_off_rules
       (organization_id, department_id, location_id, name, description, effective_from, effective_to, priority, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      values.organization_id,
      values.department_id ?? null,
      values.location_id ?? null,
      values.name,
      values.description ?? null,
      values.effective_from,
      values.effective_to ?? null,
      values.priority ?? 0,
      values.is_active ?? true,
      values.created_by ?? null,
    ],
  )
  return row as WeeklyOffRuleRow
}

export async function updateWeeklyOffRule(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<WeeklyOffRuleRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) {
    return queryOne<WeeklyOffRuleRow>(db, 'SELECT * FROM weekly_off_rules WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ])
  }
  return queryOne<WeeklyOffRuleRow>(
    db,
    `UPDATE weekly_off_rules SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function replaceWeeklyOffRuleDays(
  ruleId: string,
  days: { weekday: string; occurrences: number[] | null; includeLast: boolean; isHalfDay: boolean }[],
  db: Queryable = pool,
): Promise<void> {
  await db.query('DELETE FROM weekly_off_rule_days WHERE rule_id = $1', [ruleId])
  for (const day of days) {
    await db.query(
      `INSERT INTO weekly_off_rule_days (rule_id, weekday, occurrences, include_last, is_half_day)
       VALUES ($1, $2, $3, $4, $5)`,
      [ruleId, day.weekday, day.occurrences, day.includeLast, day.isHalfDay],
    )
  }
}

export async function deleteWeeklyOffRule(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM weekly_off_rules WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Holiday calendars
// ---------------------------------------------------------------------------

export async function listHolidayCalendars(
  organizationId: string,
  year: number | undefined,
  db: Queryable = pool,
): Promise<HolidayCalendarRow[]> {
  const params: unknown[] = [organizationId]
  let clause = 'c.organization_id = $1'
  if (year) {
    params.push(year)
    clause += ` AND c.year = $${params.length}`
  }
  return queryRows<HolidayCalendarRow>(
    db,
    `SELECT c.*, (SELECT count(*) FROM holidays h WHERE h.calendar_id = c.id)::text AS holiday_count
       FROM holiday_calendars c
      WHERE ${clause}
      ORDER BY c.year DESC, c.name ASC`,
    params,
  )
}

export async function findHolidayCalendar(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<HolidayCalendarRow | null> {
  return queryOne<HolidayCalendarRow>(db, 'SELECT * FROM holiday_calendars WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
}

export async function findDefaultCalendar(
  organizationId: string,
  year: number,
  db: Queryable = pool,
): Promise<HolidayCalendarRow | null> {
  return queryOne<HolidayCalendarRow>(
    db,
    `SELECT * FROM holiday_calendars
      WHERE organization_id = $1 AND year = $2 AND is_active
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1`,
    [organizationId, year],
  )
}

export async function insertHolidayCalendar(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<HolidayCalendarRow> {
  const row = await queryOne<HolidayCalendarRow>(
    db,
    `INSERT INTO holiday_calendars (organization_id, name, year, location_id, is_default, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.year,
      values.location_id ?? null,
      values.is_default ?? false,
      values.is_active ?? true,
    ],
  )
  return row as HolidayCalendarRow
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function listHolidays(
  organizationId: string,
  filters: { from?: IsoDate; to?: IsoDate; calendarId?: string; year?: number },
  db: Queryable = pool,
): Promise<HolidayRow[]> {
  const conditions = ['h.organization_id = $1']
  const params: unknown[] = [organizationId]

  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  if (filters.from) conditions.push(`h.holiday_date >= $${push(filters.from)}`)
  if (filters.to) conditions.push(`h.holiday_date <= $${push(filters.to)}`)
  if (filters.calendarId) conditions.push(`h.calendar_id = $${push(filters.calendarId)}`)
  if (filters.year) conditions.push(`extract(year from h.holiday_date) = $${push(filters.year)}`)

  return queryRows<HolidayRow>(
    db,
    `SELECT h.*, c.name AS calendar_name
       FROM holidays h
       LEFT JOIN holiday_calendars c ON c.id = h.calendar_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY h.holiday_date ASC`,
    params,
  )
}

export async function findHoliday(id: string, organizationId: string, db: Queryable = pool): Promise<HolidayRow | null> {
  return queryOne<HolidayRow>(db, 'SELECT * FROM holidays WHERE id = $1 AND organization_id = $2', [id, organizationId])
}

export async function insertHoliday(values: Record<string, unknown>, db: Queryable = pool): Promise<HolidayRow> {
  const row = await queryOne<HolidayRow>(
    db,
    `INSERT INTO holidays (organization_id, calendar_id, name, holiday_date, description, is_optional, is_paid, extra_pay_if_worked, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      values.organization_id,
      values.calendar_id ?? null,
      values.name,
      values.holiday_date,
      values.description ?? null,
      values.is_optional ?? false,
      values.is_paid ?? true,
      values.extra_pay_if_worked ?? false,
      values.created_by ?? null,
    ],
  )
  return row as HolidayRow
}

export async function updateHoliday(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<HolidayRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) return findHoliday(id, organizationId, db)
  return queryOne<HolidayRow>(
    db,
    `UPDATE holidays SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function deleteHoliday(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM holidays WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export async function listShifts(organizationId: string, db: Queryable = pool): Promise<ShiftRow[]> {
  return queryRows<ShiftRow>(db, 'SELECT * FROM shifts WHERE organization_id = $1 ORDER BY name', [organizationId])
}

export async function insertShift(values: Record<string, unknown>, db: Queryable = pool): Promise<ShiftRow> {
  const row = await queryOne<ShiftRow>(
    db,
    `INSERT INTO shifts (organization_id, name, code, start_time, end_time, break_minutes, is_night_shift, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      values.organization_id,
      values.name,
      values.code,
      values.start_time ?? null,
      values.end_time ?? null,
      values.break_minutes ?? 0,
      values.is_night_shift ?? false,
      values.is_active ?? true,
    ],
  )
  return row as ShiftRow
}

export async function updateShift(
  id: string,
  organizationId: string,
  updates: Record<string, unknown>,
  db: Queryable = pool,
): Promise<ShiftRow | null> {
  const { assignments, params } = buildUpdate(updates, 3)
  if (assignments.length === 0) {
    return queryOne<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = $1 AND organization_id = $2', [id, organizationId])
  }
  return queryOne<ShiftRow>(
    db,
    `UPDATE shifts SET ${assignments.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [id, organizationId, ...params],
  )
}

export async function deleteShift(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM shifts WHERE id = $1 AND organization_id = $2', [id, organizationId])
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Per-employee weekly off assignments and one-off grants
// ---------------------------------------------------------------------------

/** Every recurring assignment active at any point in [from, to], for the calendar resolver. */
export async function listWeeklyOffAssignmentsInRange(
  organizationId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<EmployeeWeeklyOffAssignmentRow[]> {
  return queryRows<EmployeeWeeklyOffAssignmentRow>(
    db,
    `SELECT * FROM employee_weekly_off_assignments
      WHERE organization_id = $1 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $2)`,
    [organizationId, from, to],
  )
}

/** Every one-off grant in [from, to], for the calendar resolver. */
export async function listExtraWeeklyOffsInRange(
  organizationId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<EmployeeExtraWeeklyOffRow[]> {
  return queryRows<EmployeeExtraWeeklyOffRow>(
    db,
    `SELECT * FROM employee_extra_weekly_offs
      WHERE organization_id = $1 AND off_date BETWEEN $2 AND $3`,
    [organizationId, from, to],
  )
}

/** The currently open (or most recent) recurring assignment for a set of employees. */
export async function listCurrentWeeklyOffAssignments(
  employeeIds: string[],
  db: Queryable = pool,
): Promise<EmployeeWeeklyOffAssignmentRow[]> {
  if (employeeIds.length === 0) return []
  return queryRows<EmployeeWeeklyOffAssignmentRow>(
    db,
    `SELECT DISTINCT ON (employee_id) *
       FROM employee_weekly_off_assignments
      WHERE employee_id = ANY($1::uuid[])
      ORDER BY employee_id, effective_to IS NULL DESC, effective_from DESC`,
    [employeeIds],
  )
}

export async function closeOpenWeeklyOffAssignment(
  employeeId: string,
  before: IsoDate,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE employee_weekly_off_assignments
        SET effective_to = $2::date - INTERVAL '1 day'
      WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to >= $2::date) AND effective_from < $2::date`,
    [employeeId, before],
  )
  // An assignment that would start on or after the new one's start date is fully
  // superseded before it ever took effect - remove it rather than leave a
  // zero-or-negative-length range behind.
  await db.query(
    `DELETE FROM employee_weekly_off_assignments WHERE employee_id = $1 AND effective_from >= $2`,
    [employeeId, before],
  )
}

export async function insertWeeklyOffAssignment(
  values: Record<string, unknown>,
  db: Queryable = pool,
): Promise<EmployeeWeeklyOffAssignmentRow> {
  const row = await queryOne<EmployeeWeeklyOffAssignmentRow>(
    db,
    `INSERT INTO employee_weekly_off_assignments
       (organization_id, employee_id, weekday, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      values.organization_id,
      values.employee_id,
      values.weekday,
      values.effective_from,
      values.effective_to ?? null,
      values.created_by ?? null,
    ],
  )
  return row as EmployeeWeeklyOffAssignmentRow
}

export async function findWeeklyOffAssignment(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<EmployeeWeeklyOffAssignmentRow | null> {
  return queryOne<EmployeeWeeklyOffAssignmentRow>(
    db,
    'SELECT * FROM employee_weekly_off_assignments WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
}

export async function deleteWeeklyOffAssignment(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM employee_weekly_off_assignments WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
  return (result.rowCount ?? 0) > 0
}

export async function insertExtraWeeklyOffs(
  organizationId: string,
  employeeIds: string[],
  offDate: IsoDate,
  source: string,
  grantedBy: string | null,
  db: Queryable = pool,
): Promise<void> {
  for (const employeeId of employeeIds) {
    await db.query(
      `INSERT INTO employee_extra_weekly_offs (organization_id, employee_id, off_date, source, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employee_id, off_date) DO NOTHING`,
      [organizationId, employeeId, offDate, source, grantedBy],
    )
  }
}

export async function findExtraWeeklyOff(
  id: string,
  organizationId: string,
  db: Queryable = pool,
): Promise<EmployeeExtraWeeklyOffRow | null> {
  return queryOne<EmployeeExtraWeeklyOffRow>(
    db,
    'SELECT * FROM employee_extra_weekly_offs WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
}

/** In-scope employees for the weekly-off assignment calendar, with their current resolved status for one week. */
export interface WeeklyOffCalendarEmployeeRow {
  employee_id: string
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  department_id: string | null
  department_name: string | null
  supervisor_id: string | null
  supervisor_name: string | null
  location_id: string | null
}

export async function listEmployeesForWeeklyOffCalendar(
  scope: { sql: string; params: unknown[] },
  filters: { departmentId?: string; supervisorId?: string; search?: string },
  db: Queryable = pool,
): Promise<WeeklyOffCalendarEmployeeRow[]> {
  const params: unknown[] = [...scope.params]
  const push = (value: unknown): number => {
    params.push(value)
    return params.length
  }

  const conditions = [`(${scope.sql})`, `e.employment_status <> 'INACTIVE'`]
  if (filters.departmentId) conditions.push(`e.department_id = $${push(filters.departmentId)}`)
  if (filters.supervisorId) conditions.push(`e.supervisor_id = $${push(filters.supervisorId)}`)
  if (filters.search) {
    const index = push(`%${filters.search}%`)
    conditions.push(`(e.employee_code ILIKE $${index} OR e.first_name ILIKE $${index} OR e.last_name ILIKE $${index})`)
  }

  return queryRows<WeeklyOffCalendarEmployeeRow>(
    db,
    `SELECT e.id AS employee_id,
            e.employee_code,
            e.first_name,
            e.middle_name,
            e.last_name,
            e.department_id,
            d.name AS department_name,
            e.supervisor_id,
            CASE WHEN s.id IS NULL THEN NULL
                 ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name,
            e.location_id
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employees   s ON s.id = e.supervisor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.employee_code ASC`,
    params,
  )
}

export async function deleteExtraWeeklyOff(id: string, organizationId: string, db: Queryable = pool): Promise<boolean> {
  const result = await db.query('DELETE FROM employee_extra_weekly_offs WHERE id = $1 AND organization_id = $2', [
    id,
    organizationId,
  ])
  return (result.rowCount ?? 0) > 0
}

/** Removes a one-off grant for an employee on an exact date, if one exists. */
export async function deleteExtraWeeklyOffForDate(
  employeeId: string,
  offDate: IsoDate,
  db: Queryable = pool,
): Promise<void> {
  await db.query('DELETE FROM employee_extra_weekly_offs WHERE employee_id = $1 AND off_date = $2', [
    employeeId,
    offDate,
  ])
}
