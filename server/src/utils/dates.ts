/**
 * Calendar helpers that operate on plain `YYYY-MM-DD` strings.
 *
 * Attendance and payroll are date-only concepts; using UTC-anchored Date objects
 * everywhere avoids the timezone drift that would otherwise shift an attendance
 * record onto the wrong day.
 */

export type IsoDate = string

export const WEEKDAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const

export type WeekdayName = (typeof WEEKDAY_NAMES)[number]

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && toIsoDate(parsed) === value
}

export function toIsoDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10)
}

export function parseIsoDate(value: IsoDate): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

/** Normalises whatever pg hands back (Date or string) into `YYYY-MM-DD`. */
export function normaliseDate(value: Date | string | null | undefined): IsoDate | null {
  if (!value) return null
  if (value instanceof Date) return toIsoDate(value)
  return value.slice(0, 10)
}

export function todayIso(): IsoDate {
  return toIsoDate(new Date())
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return toIsoDate(date)
}

export function weekdayOf(value: IsoDate): WeekdayName {
  const index = parseIsoDate(value).getUTCDay()
  return WEEKDAY_NAMES[index] as WeekdayName
}

/** The Monday on or before this date - used to bucket overtime into ISO weeks. */
export function startOfIsoWeek(value: IsoDate): IsoDate {
  const dayIndex = parseIsoDate(value).getUTCDay() // 0 = Sunday
  const back = dayIndex === 0 ? 6 : dayIndex - 1
  return addDays(value, -back)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function firstDayOfMonth(year: number, month: number): IsoDate {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function lastDayOfMonth(year: number, month: number): IsoDate {
  return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`
}

/**
 * The organization's payroll cycle: the 21st of the previous month through the
 * 20th of the named month, fixed for everyone. There is no per-organization
 * override - every part of the system (payroll, attendance) uses this one
 * constant so a payroll month and its attendance window always agree.
 */
export const PAYROLL_CYCLE_CUTOFF_DAY = 20

/**
 * The pay cycle labelled (year, month): normally the calendar month, but when
 * `cutoffDay` is set the cycle instead runs from the day after `cutoffDay` in the
 * previous month through `cutoffDay` of this month - so, for example, a cutoff of
 * 20 makes "September" mean Aug 21 - Sep 20, with the 21st-onward tail of every
 * month belonging to the next month's cycle. `cutoffDay: null` reproduces the
 * plain calendar month exactly.
 */
export function payCycleFor(year: number, month: number, cutoffDay: number | null): { start: IsoDate; end: IsoDate } {
  if (cutoffDay === null) {
    return { start: firstDayOfMonth(year, month), end: lastDayOfMonth(year, month) }
  }

  const clampedCutoff = Math.min(cutoffDay, daysInMonth(year, month))
  const end = `${year}-${String(month).padStart(2, '0')}-${String(clampedCutoff).padStart(2, '0')}`

  const previousMonth = month === 1 ? 12 : month - 1
  const previousYear = month === 1 ? year - 1 : year
  const previousCutoff = Math.min(cutoffDay, daysInMonth(previousYear, previousMonth))
  const start = addDays(
    `${previousYear}-${String(previousMonth).padStart(2, '0')}-${String(previousCutoff).padStart(2, '0')}`,
    1,
  )

  return { start, end }
}

/** Which (year, month) pay cycle a date falls in, under the given cutoff day. */
export function payCycleContaining(
  date: IsoDate,
  cutoffDay: number | null,
): { year: number; month: number; start: IsoDate; end: IsoDate } {
  const parsed = parseIsoDate(date)
  const year = parsed.getUTCFullYear()
  const month = parsed.getUTCMonth() + 1
  const day = parsed.getUTCDate()

  if (cutoffDay === null || day <= Math.min(cutoffDay, daysInMonth(year, month))) {
    return { year, month, ...payCycleFor(year, month, cutoffDay) }
  }

  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return { year: nextYear, month: nextMonth, ...payCycleFor(nextYear, nextMonth, cutoffDay) }
}

/** Every date in the given month, inclusive, as ISO strings. */
export function datesInMonth(year: number, month: number): IsoDate[] {
  const total = daysInMonth(year, month)
  const dates: IsoDate[] = []
  for (let day = 1; day <= total; day += 1) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return dates
}

export function datesBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const dates: IsoDate[] = []
  let cursor = from
  let guard = 0
  while (cursor <= to && guard < 3660) {
    dates.push(cursor)
    cursor = addDays(cursor, 1)
    guard += 1
  }
  return dates
}

export function countDaysBetween(from: IsoDate, to: IsoDate): number {
  const diff = parseIsoDate(to).getTime() - parseIsoDate(from).getTime()
  return Math.floor(diff / 86_400_000) + 1
}

/**
 * Which occurrence of its weekday this date is within its month.
 * The 2nd Saturday of a month returns 2 — used by weekly off rules such as
 * "2nd and 4th Saturday" (plan section 8).
 */
export function weekdayOccurrenceInMonth(value: IsoDate): number {
  const day = parseIsoDate(value).getUTCDate()
  return Math.floor((day - 1) / 7) + 1
}

/** True when the date is the last occurrence of its weekday in the month. */
export function isLastWeekdayOccurrence(value: IsoDate): boolean {
  const date = parseIsoDate(value)
  const total = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1)
  return date.getUTCDate() + 7 > total
}

export function monthLabel(year: number, month: number, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}

export function clampDate(value: IsoDate, min: IsoDate, max: IsoDate): IsoDate {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Overlap of [aStart,aEnd] and [bStart,bEnd], or null when they are disjoint. */
export function overlapRange(
  aStart: IsoDate,
  aEnd: IsoDate,
  bStart: IsoDate,
  bEnd: IsoDate,
): { from: IsoDate; to: IsoDate } | null {
  const from = aStart > bStart ? aStart : bStart
  const to = aEnd < bEnd ? aEnd : bEnd
  return from <= to ? { from, to } : null
}
