import { pool, type Queryable } from '../../database/pool.js'
import {
  datesBetween,
  isLastWeekdayOccurrence,
  weekdayOccurrenceInMonth,
  weekdayOf,
  type IsoDate,
} from '../../utils/dates.js'
import * as repository from './calendar.repository.js'

/**
 * The calendar resolver.
 *
 * Attendance marking, the monthly calendar view and the payroll engine all need
 * the same answer to "what kind of day is this for this employee?". That answer
 * comes from configuration only - weekly offs and holidays are never hard-coded
 * (plan sections 8, 9 and 63 rule 17).
 */

export type DayKind = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'

export interface DayInfo {
  date: IsoDate
  kind: DayKind
  /** Set when the weekly off rule marks the day as a half working day. */
  isHalfWeeklyOff: boolean
  holidayId: string | null
  holidayName: string | null
  holidayIsOptional: boolean
  holidayIsPaid: boolean
  /** Working this holiday earns one extra day's pay (see payroll.calculator). */
  holidayExtraPay: boolean
}

export interface EmployeeCalendarScope {
  departmentId?: string | null
  locationId?: string | null
  /**
   * When set, a per-employee weekly-off assignment or one-off grant for this
   * employee overrides the department/location rule for that date (plan: "per
   * employee weekly off"). Omit for scope-only resolution (e.g. the admin
   * working-days preview, which has no single employee in mind).
   */
  employeeId?: string | null
}

export interface CalendarContext {
  from: IsoDate
  to: IsoDate
  /** Resolves a single date for an employee in the given scope. */
  dayFor(date: IsoDate, scope: EmployeeCalendarScope): DayInfo
  /** Every date in the window, resolved for one scope. */
  daysFor(scope: EmployeeCalendarScope): DayInfo[]
  countWorkingDays(scope: EmployeeCalendarScope): number
}

/** Does a rule apply to this employee's department/location? */
function ruleMatchesScope(rule: repository.WeeklyOffRuleWithDays, scope: EmployeeCalendarScope): boolean {
  if (rule.department_id && rule.department_id !== scope.departmentId) return false
  if (rule.location_id && rule.location_id !== scope.locationId) return false
  return true
}

function ruleCoversDate(rule: repository.WeeklyOffRuleWithDays, date: IsoDate): boolean {
  if (!rule.is_active) return false
  if (date < rule.effective_from) return false
  if (rule.effective_to && date > rule.effective_to) return false
  return true
}

/**
 * How specific a rule is. A department+location rule beats a department rule,
 * which beats an organization-wide one; `priority` breaks remaining ties.
 */
function specificity(rule: repository.WeeklyOffRuleWithDays): number {
  return (rule.department_id ? 2 : 0) + (rule.location_id ? 1 : 0)
}

function selectRule(
  rules: repository.WeeklyOffRuleWithDays[],
  date: IsoDate,
  scope: EmployeeCalendarScope,
): repository.WeeklyOffRuleWithDays | null {
  let best: repository.WeeklyOffRuleWithDays | null = null
  for (const rule of rules) {
    if (!ruleCoversDate(rule, date) || !ruleMatchesScope(rule, scope)) continue
    if (!best) {
      best = rule
      continue
    }
    const bestScore = specificity(best) * 1000 + best.priority
    const ruleScore = specificity(rule) * 1000 + rule.priority
    if (ruleScore > bestScore) best = rule
  }
  return best
}

/**
 * Whether a date falls on a weekly off under the given rule.
 *
 * `occurrences = null` means every occurrence of that weekday ("every Sunday");
 * `{2,4}` means the 2nd and 4th ("2nd and 4th Saturday"); `include_last` adds
 * the final occurrence of the month regardless of its ordinal.
 */
function isWeeklyOff(
  rule: repository.WeeklyOffRuleWithDays,
  date: IsoDate,
): { off: boolean; halfDay: boolean } {
  const weekday = weekdayOf(date)
  const day = rule.days.find((entry) => entry.weekday === weekday)
  if (!day) return { off: false, halfDay: false }

  if (day.occurrences === null || day.occurrences.length === 0) {
    return { off: true, halfDay: day.is_half_day }
  }

  const occurrence = weekdayOccurrenceInMonth(date)
  if (day.occurrences.includes(occurrence)) return { off: true, halfDay: day.is_half_day }
  if (day.include_last && isLastWeekdayOccurrence(date)) return { off: true, halfDay: day.is_half_day }

  return { off: false, halfDay: false }
}

/**
 * Loads every rule and holiday for a window once, then answers day questions in
 * memory. Payroll resolves thousands of employee-days, so this avoids the N+1
 * queries the plan warns about in section 59.
 */
export async function buildCalendarContext(
  organizationId: string,
  from: IsoDate,
  to: IsoDate,
  db: Queryable = pool,
): Promise<CalendarContext> {
  const [rules, holidays, weeklyOffAssignments, extraWeeklyOffs] = await Promise.all([
    repository.listWeeklyOffRules(organizationId, { activeOnly: true }, db),
    repository.listHolidays(organizationId, { from, to }, db),
    repository.listWeeklyOffAssignmentsInRange(organizationId, from, to, db),
    repository.listExtraWeeklyOffsInRange(organizationId, from, to, db),
  ])

  const holidayByDate = new Map<IsoDate, repository.HolidayRow>()
  for (const holiday of holidays) {
    // A mandatory holiday wins over an optional one on the same date.
    const existing = holidayByDate.get(holiday.holiday_date)
    if (!existing || (existing.is_optional && !holiday.is_optional)) {
      holidayByDate.set(holiday.holiday_date, holiday)
    }
  }

  // Per-employee overrides, kept out of the department/location cache below so
  // that cache still resolves once per scope rather than once per employee - the
  // N+1 concern this function already exists to avoid (see the comment above).
  const extraOffByEmployee = new Map<string, Set<IsoDate>>()
  for (const grant of extraWeeklyOffs) {
    const set = extraOffByEmployee.get(grant.employee_id) ?? new Set<IsoDate>()
    set.add(grant.off_date)
    extraOffByEmployee.set(grant.employee_id, set)
  }

  const assignmentsByEmployee = new Map<string, repository.EmployeeWeeklyOffAssignmentRow[]>()
  for (const assignment of weeklyOffAssignments) {
    const list = assignmentsByEmployee.get(assignment.employee_id) ?? []
    list.push(assignment)
    assignmentsByEmployee.set(assignment.employee_id, list)
  }

  function employeeAssignmentCoversDate(employeeId: string, date: IsoDate): boolean {
    const assignments = assignmentsByEmployee.get(employeeId)
    if (!assignments) return false
    const weekday = weekdayOf(date)
    return assignments.some(
      (assignment) =>
        assignment.weekday === weekday &&
        date >= assignment.effective_from &&
        (assignment.effective_to === null || date <= assignment.effective_to),
    )
  }

  const WEEKLY_OFF_DAY: Omit<DayInfo, 'date'> = {
    kind: 'WEEKLY_OFF',
    isHalfWeeklyOff: false,
    holidayId: null,
    holidayName: null,
    holidayIsOptional: false,
    holidayIsPaid: true,
    holidayExtraPay: false,
  }

  const allDates = datesBetween(from, to)
  // Cache per department/location scope so a run over many employees in one
  // department resolves once; the employee-specific layer above is cheap map
  // lookups on top, so it never needs the same caching.
  const cache = new Map<string, Map<IsoDate, DayInfo>>()

  function scopeKey(scope: EmployeeCalendarScope): string {
    return `${scope.departmentId ?? '-'}|${scope.locationId ?? '-'}`
  }

  function resolveScope(scope: EmployeeCalendarScope): Map<IsoDate, DayInfo> {
    const key = scopeKey(scope)
    const cached = cache.get(key)
    if (cached) return cached

    const resolved = new Map<IsoDate, DayInfo>()
    for (const date of allDates) {
      const holiday = holidayByDate.get(date)
      const rule = selectRule(rules, date, scope)
      const weekly = rule ? isWeeklyOff(rule, date) : { off: false, halfDay: false }

      // A holiday that lands on a weekly off stays a weekly off: the employee was
      // not scheduled to work, so it must not be double counted.
      let kind: DayKind = 'WORKING'
      if (weekly.off && !weekly.halfDay) kind = 'WEEKLY_OFF'
      else if (holiday && !holiday.is_optional) kind = 'HOLIDAY'

      resolved.set(date, {
        date,
        kind,
        isHalfWeeklyOff: weekly.off && weekly.halfDay,
        holidayId: holiday?.id ?? null,
        holidayName: holiday?.name ?? null,
        holidayIsOptional: holiday?.is_optional ?? false,
        holidayIsPaid: holiday?.is_paid ?? true,
        holidayExtraPay: holiday?.extra_pay_if_worked ?? false,
      })
    }

    cache.set(key, resolved)
    return resolved
  }

  // A per-employee grant or assignment beats the department/location rule for
  // that date - it is the most specific thing that can be said about a day.
  function resolveDay(date: IsoDate, scope: EmployeeCalendarScope): DayInfo {
    if (scope.employeeId) {
      if (extraOffByEmployee.get(scope.employeeId)?.has(date)) {
        return { date, ...WEEKLY_OFF_DAY }
      }
      if (employeeAssignmentCoversDate(scope.employeeId, date)) {
        return { date, ...WEEKLY_OFF_DAY }
      }
    }

    const resolved = resolveScope(scope)
    return (
      resolved.get(date) ?? {
        date,
        kind: 'WORKING',
        isHalfWeeklyOff: false,
        holidayId: null,
        holidayName: null,
        holidayIsOptional: false,
        holidayIsPaid: true,
        holidayExtraPay: false,
      }
    )
  }

  return {
    from,
    to,
    dayFor(date, scope) {
      return resolveDay(date, scope)
    },
    daysFor(scope) {
      return allDates.map((date) => resolveDay(date, scope))
    },
    countWorkingDays(scope) {
      let count = 0
      for (const date of allDates) {
        if (resolveDay(date, scope).kind === 'WORKING') count += 1
      }
      return count
    },
  }
}
