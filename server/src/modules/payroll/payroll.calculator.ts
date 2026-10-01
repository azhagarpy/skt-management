import {
  addMinor,
  minMinor,
  multiplyMinor,
  percentOfMinor,
  prorateMinor,
  roundHalfUp,
  type Minor,
} from '../../utils/money.js'
import type { IsoDate } from '../../utils/dates.js'

/**
 * The payroll calculation engine.
 *
 * This module is deliberately pure: it takes a fully materialised snapshot of
 * one employee's month and returns the figures, touching no database and no
 * clock. That is what makes payroll reproducible and testable (plan section 63,
 * rules 14 and 9), and it is why `payroll.service` is responsible for loading
 * the inputs and persisting the snapshot.
 *
 * Every money value crossing this boundary is an integer number of paise.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type DayKind = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'

export type AttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'ON_LEAVE'
  | 'HALF_DAY_LEAVE'
  | 'HOLIDAY'
  | 'WEEKLY_OFF'

export interface DayInput {
  date: IsoDate
  /** What the configured calendar says this day is, before any marking. */
  dayKind: DayKind
  /** The marked status, or null when the day was never marked. */
  status: AttendanceStatus | null
  /** Whether the leave type on this day is paid; null when the day is not leave. */
  leaveIsPaid: boolean | null
  /** False for days before joining or after exit. */
  isEmployed: boolean
  /** The day is a holiday that pays one extra day to whoever works it. */
  holidayExtraPay?: boolean
  /** The holiday's name, shown beside the extra pay it earned. */
  holidayName?: string | null
  /**
   * A holiday not worked, with an unpaid absence on the day before and the day
   * after: it is not paid (see `forfeitedHolidayDates`).
   */
  holidayForfeited?: boolean
}

/**
 * CREDIT is an amount added straight to net pay (overtime and Other Credits):
 * not an earning, so it stays out of gross and every wage worked out from it.
 * A salary structure component is never a credit.
 */
export type ComponentType = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'CREDIT'
export type CalculationType = 'FIXED' | 'PERCENTAGE'
export type PercentageBase = 'BASIC' | 'GROSS' | 'CTC' | 'COMPONENT'

export interface ComponentInput {
  code: string
  name: string
  componentType: ComponentType
  calculationType: CalculationType
  /** Full-period amount in paise for a FIXED component. */
  amountMinor: Minor
  /** Percentage value for a PERCENTAGE component, e.g. 40 for 40%. */
  percentage: number
  percentageBase: PercentageBase | null
  baseComponentCode: string | null
  taxable: boolean
  /** When false the component is paid in full regardless of attendance. */
  prorate: boolean
  /**
   * When false the component is left out of holiday pay ("Include in holiday
   * extra pay" unticked): it is not paid for a holiday the employee rested on,
   * and working a holiday earns the extra day without it. It is still paid for
   * every day worked - a worked holiday included - and for paid leave.
   */
  holidayExtraPay: boolean
  displayOrder: number
}

/** The tax set to be deducted from this employee's pay this month (see the tax module). */
export interface TaxInput {
  id: string
  amountMinor: Minor
  /** How it was worked out, shown beside the deduction. */
  note: string | null
}

/** A tax slab: the tax for wages up to `upToMinor`, or above the slab before it when null. */
export interface TaxSlabInput {
  upToMinor: Minor | null
  taxMinor: Minor
}

/**
 * P.Tax for a leaver, taken from their final salary (see tax-on-exit.ts): the
 * half-year's tax on its wages so far. It depends on this month's wages, so it
 * is worked out here rather than set as an amount.
 */
export interface ExitTaxInput {
  id: string
  /** Salary-structure earnings from the half-year's earlier months. */
  priorWagesMinor: Minor
  slabs: TaxSlabInput[]
  /** The half-year's start and the end of this month, for the payslip note. */
  periodFrom: IsoDate
  periodTo: IsoDate
}

/** The employee's Labour Welfare Fund contribution due this month (see the lwf module). */
export interface LwfInput {
  id: string
  amountMinor: Minor
  note: string | null
}

/** Overtime hours recorded at one rate. */
export interface OvertimeInput {
  hours: number
  /** One day's salary / `dayDivisor` an hour, or a custom `ratePerHourMinor`. */
  basis: 'DAY_SALARY' | 'CUSTOM'
  dayDivisor: number | null
  ratePerHourMinor: Minor | null
}

export interface AdjustmentInput {
  id: string
  code: string
  name: string
  componentType: ComponentType
  /** Signed: positive adds to the side named by componentType. */
  amountMinor: Minor
  reason: string
}

/** A structure's PF or ESI rates, and whether the employee is enrolled at all. */
export interface StatutoryInput {
  applicable: boolean
  employeeRate: number
  employerRate: number
  /**
   * PF: the wage is capped at this ceiling before either side's rate is
   * applied. ESI: the scheme applies only when a standard month's wage is at or
   * below this limit (see `esiEligibilityWage`), and the wage is then capped at
   * it too. Zero means no cap (or, for ESI, no limit: it always applies).
   */
  wageLimitMinor: Minor
  /**
   * PF only: the share of `employerRate` that goes to the Pension Scheme
   * (EPS) rather than EPF, e.g. 8.33 out of a 12% employer rate. Ignored for ESI.
   */
  epsRate?: number
}

export interface PolicyInput {
  paidDaysBasis: 'CALENDAR_DAYS' | 'WORKING_DAYS' | 'ACTUAL_ATTENDANCE_DAYS'
  /** Total paid fraction of a half-day-leave day when the leave half is paid. */
  halfDayPaidFraction: number
  /** Total paid fraction when the leave half is unpaid. */
  halfDayUnpaidFraction: number
  countHolidaysAsPaid: boolean
  countWeeklyOffAsPaid: boolean
  prorateOnJoining: boolean
  prorateOnExit: boolean
  netRoundingDecimals: number
}

export interface CalculatorInput {
  period: { year: number; month: number; start: IsoDate; end: IsoDate }
  employee: {
    id: string
    code: string
    name: string
    salaryBasis: 'MONTHLY' | 'DAILY'
  }
  days: DayInput[]
  components: ComponentInput[]
  /**
   * PSR overtime for the period, the hours totalled per rate they were recorded
   * at. Empty for a Supply employee, whose overtime converts to extra weekly
   * offs instead (overtime.service.ts) and never touches payroll money.
   */
  overtime: OvertimeInput[]
  /**
   * Per-employee total that replaces the structure total: monthly gross for a
   * MONTHLY structure, daily rate for a DAILY one. Components are scaled
   * proportionally so the breakdown still adds up.
   */
  overrideTotalMinor: Minor | null
  /** Null when no tax is to be deducted from this employee this month. */
  tax: TaxInput | null
  /** Set only in a leaver's final month, when P.Tax is to be deducted on exit. */
  exitTax?: ExitTaxInput | null
  /** Null when no Labour Welfare Fund contribution is due from this employee this month. */
  lwf: LwfInput | null
  adjustments: AdjustmentInput[]
  /** PF is deducted on the structure's wage, capped at `pf.wageLimitMinor`. */
  pf: StatutoryInput
  /**
   * ESI applies only when a standard month's wage is at or below
   * `esi.wageLimitMinor`, and is then deducted on the wage capped at that limit.
   */
  esi: StatutoryInput
  policy: PolicyInput
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ComponentSource =
  | 'SALARY_STRUCTURE'
  | 'OVERTIME'
  | 'HOLIDAY_WORK'
  | 'STATUTORY'
  | 'ADJUSTMENT'
  | 'MANUAL'

export interface ComponentResult {
  code: string
  name: string
  componentType: ComponentType
  calculationType: CalculationType
  source: ComponentSource
  /** The entitlement before attendance proration. */
  fullAmountMinor: Minor
  /** What actually lands on the payslip. */
  amountMinor: Minor
  percentage: number | null
  taxable: boolean
  displayOrder: number
  referenceId: string | null
  notes: string | null
}

export interface AttendanceSummary {
  calendarDays: number
  workingDays: number
  presentDays: number
  absentDays: number
  leaveDays: number
  paidLeaveDays: number
  unpaidLeaveDays: number
  halfDayLeaveDays: number
  holidayDays: number
  weeklyOffDays: number
  unmarkedDays: number
  paidDays: number
  /**
   * How many of `paidDays` are holidays the employee rested on (not worked,
   * not forfeited). A component left out of holiday pay is not paid for them.
   */
  paidHolidayDays: number
  /** The denominator used to prorate a monthly salary. */
  payableDaysBasis: number
}

export interface CalculatorOutput {
  employeeId: string
  attendance: AttendanceSummary
  components: ComponentResult[]
  grossEarningsMinor: Minor
  totalDeductionsMinor: Minor
  /** Overtime pay: added to net pay after deductions, never part of gross. */
  totalOvertimeMinor: Minor
  /** Other Credits: added to net pay after deductions, never part of gross. */
  totalCreditsMinor: Minor
  employerContributionsMinor: Minor
  /** The wage PF/ESI were actually calculated on this run (0 when not applicable). */
  pfWageMinor: Minor
  /** The ceiling that was in force for this run (0 when PF is not applicable). */
  pfWageCeilingMinor: Minor
  esiWageMinor: Minor
  netSalaryMinor: Minor
  /** What the P.Tax on exit came to, for the tax module to record. Null when none was due. */
  exitTax: { id: string; wageBaseMinor: Minor; amountMinor: Minor } | null
  /** Non-fatal conditions the reviewer should see before approving. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/** A holiday the employee did not work: marked as one, or never marked. */
function isRestedHoliday(day: DayInput): boolean {
  return day.status === 'HOLIDAY' || (day.status === null && day.dayKind === 'HOLIDAY')
}

/** A full day that earns nothing: absent, or on unpaid leave. */
function isUnpaidAbsence(day: DayInput): boolean {
  return day.status === 'ABSENT' || (day.status === 'ON_LEAVE' && day.leaveIsPaid === false)
}

/**
 * A day that brackets a holiday for the sandwich rule: an unpaid absence, or a
 * half day - working only half the day before or after a holiday counts the
 * same as taking it off.
 */
function isSandwichSide(day: DayInput): boolean {
  return isUnpaidAbsence(day) || day.status === 'HALF_DAY_LEAVE'
}

/**
 * The payroll side of the sandwich rule: a holiday is paid only to someone who
 * did not skip both the day before and the day after it, where a half day
 * counts as skipped. A run of consecutive holidays is judged as one, by the
 * days either side of the whole run; a weekly off, a full worked day or any
 * paid full day next to it breaks the sandwich. A holiday that was worked is
 * never forfeited - a full day keeps its pay and any extra holiday-work pay,
 * and a half day is paid as the half day it is (see `summariseAttendance`).
 *
 * Paid full-day leave either side is not an absence here: the leave module's
 * own sandwich rule already charges such a holiday as leave (leave.service.ts).
 *
 * `days` must be consecutive and in date order, and should reach a few days
 * beyond the payroll period so a holiday at either edge has its neighbours.
 */
export function forfeitedHolidayDates(days: DayInput[]): Set<IsoDate> {
  const forfeited = new Set<IsoDate>()
  let index = 0
  while (index < days.length) {
    const day = days[index] as DayInput
    if (!isRestedHoliday(day)) {
      index += 1
      continue
    }
    let end = index
    while (end + 1 < days.length && isRestedHoliday(days[end + 1] as DayInput)) end += 1

    const before = days[index - 1]
    const after = days[end + 1]
    if (before && after && isSandwichSide(before) && isSandwichSide(after)) {
      for (let position = index; position <= end; position += 1) forfeited.add((days[position] as DayInput).date)
    }
    index = end + 1
  }
  return forfeited
}

/** Rounds a day count to two decimals so half days stay exact. */
function roundDays(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Turns the day-by-day record into the counts payroll needs.
 *
 * Numerator (paid days) and denominator (payable days basis) are always measured
 * over the same population of days, which is what keeps a prorated salary
 * internally consistent:
 *
 *   CALENDAR_DAYS           every employed day; holidays and weekly offs count
 *                           as paid when the policy says so.
 *   WORKING_DAYS            working days only; holidays and weekly offs are
 *                           excluded from both sides.
 *   ACTUAL_ATTENDANCE_DAYS  only days that carry an attendance record.
 */
export function summariseAttendance(days: DayInput[], policy: PolicyInput): AttendanceSummary {
  let calendarDays = 0
  let workingDays = 0
  let presentDays = 0
  let absentDays = 0
  let paidLeaveDays = 0
  let unpaidLeaveDays = 0
  let halfDayLeaveDays = 0
  let holidayDays = 0
  let weeklyOffDays = 0
  let unmarkedDays = 0
  let paidDays = 0
  let workingPaidDays = 0
  let attendanceDays = 0
  let attendancePaidDays = 0
  // The rested holidays inside each basis's paid days.
  let holidayPaidDays = 0
  let workingHolidayPaidDays = 0
  let attendanceHolidayPaidDays = 0

  for (const day of days) {
    if (!day.isEmployed) continue
    calendarDays += 1

    const effective = day.status ?? (day.dayKind === 'HOLIDAY' ? 'HOLIDAY' : day.dayKind === 'WEEKLY_OFF' ? 'WEEKLY_OFF' : null)
    const isWorkingDay = day.dayKind === 'WORKING'
    if (isWorkingDay) workingDays += 1
    if (day.status !== null) attendanceDays += 1

    // How much of this day is paid, before the basis is chosen.
    let dayPaid = 0

    switch (effective) {
      case 'PRESENT':
        presentDays += 1
        dayPaid = 1
        break

      case 'ABSENT':
        absentDays += 1
        dayPaid = 0
        break

      case 'ON_LEAVE':
        if (day.leaveIsPaid) {
          paidLeaveDays += 1
          dayPaid = 1
        } else {
          unpaidLeaveDays += 1
          dayPaid = 0
        }
        break

      case 'HALF_DAY_LEAVE':
        halfDayLeaveDays += 1
        if (day.dayKind === 'HOLIDAY') {
          // Half a holiday worked earns that half day; any extra pay the holiday
          // carries is added as holiday work pay in calculatePayrollItem.
          dayPaid = 0.5
          unpaidLeaveDays += 0.5
          break
        }
        // The worked half plus whatever the policy grants for the leave half.
        dayPaid = day.leaveIsPaid ? policy.halfDayPaidFraction : policy.halfDayUnpaidFraction
        if (day.leaveIsPaid) paidLeaveDays += 0.5
        else unpaidLeaveDays += 0.5
        break

      case 'HOLIDAY':
        if (day.holidayForfeited) {
          // Absent either side: the holiday is an unpaid absence too.
          absentDays += 1
          dayPaid = 0
          break
        }
        holidayDays += 1
        dayPaid = policy.countHolidaysAsPaid ? 1 : 0
        break

      case 'WEEKLY_OFF':
        weeklyOffDays += 1
        dayPaid = policy.countWeeklyOffAsPaid ? 1 : 0
        break

      default:
        // A working day nobody marked. It is treated as unpaid and surfaced as a
        // warning rather than silently paid, so the reviewer notices.
        unmarkedDays += 1
        dayPaid = 0
        break
    }

    paidDays += dayPaid
    if (isWorkingDay) workingPaidDays += dayPaid
    if (day.status !== null) attendancePaidDays += dayPaid

    // A rested holiday is paid as the holiday, not as work (see paidHolidayDays).
    if (effective === 'HOLIDAY' && !day.holidayForfeited) {
      holidayPaidDays += dayPaid
      if (isWorkingDay) workingHolidayPaidDays += dayPaid
      if (day.status !== null) attendanceHolidayPaidDays += dayPaid
    }
  }

  let payableDaysBasis: number
  let effectivePaidDays: number
  let effectiveHolidayPaidDays: number

  switch (policy.paidDaysBasis) {
    case 'WORKING_DAYS':
      payableDaysBasis = workingDays
      effectivePaidDays = workingPaidDays
      effectiveHolidayPaidDays = workingHolidayPaidDays
      break
    case 'ACTUAL_ATTENDANCE_DAYS':
      payableDaysBasis = attendanceDays
      effectivePaidDays = attendancePaidDays
      effectiveHolidayPaidDays = attendanceHolidayPaidDays
      break
    case 'CALENDAR_DAYS':
    default:
      payableDaysBasis = calendarDays
      effectivePaidDays = paidDays
      effectiveHolidayPaidDays = holidayPaidDays
      break
  }

  return {
    calendarDays: roundDays(calendarDays),
    workingDays: roundDays(workingDays),
    presentDays: roundDays(presentDays),
    absentDays: roundDays(absentDays),
    leaveDays: roundDays(paidLeaveDays + unpaidLeaveDays),
    paidLeaveDays: roundDays(paidLeaveDays),
    unpaidLeaveDays: roundDays(unpaidLeaveDays),
    halfDayLeaveDays: roundDays(halfDayLeaveDays),
    holidayDays: roundDays(holidayDays),
    weeklyOffDays: roundDays(weeklyOffDays),
    unmarkedDays: roundDays(unmarkedDays),
    paidDays: roundDays(effectivePaidDays),
    paidHolidayDays: roundDays(effectiveHolidayPaidDays),
    payableDaysBasis: roundDays(payableDaysBasis),
  }
}

// ---------------------------------------------------------------------------
// Salary components
// ---------------------------------------------------------------------------

interface ResolvedComponent {
  input: ComponentInput
  fullAmountMinor: Minor
}

/**
 * Resolves each structure component to its full-period entitlement.
 *
 * Fixed components resolve first; percentage components are then evaluated
 * against the base they name. A percentage of GROSS uses the fixed earnings
 * total, which keeps evaluation single-pass and order independent.
 */
function resolveComponents(components: ComponentInput[]): ResolvedComponent[] {
  const fixed = components.filter((component) => component.calculationType === 'FIXED')
  const percentage = components.filter((component) => component.calculationType === 'PERCENTAGE')

  const fixedByCode = new Map<string, Minor>()
  let fixedEarningsMinor = 0
  for (const component of fixed) {
    fixedByCode.set(component.code, component.amountMinor)
    if (component.componentType === 'EARNING') fixedEarningsMinor += component.amountMinor
  }

  const basicMinor = fixedByCode.get('BASIC') ?? 0

  const resolved: ResolvedComponent[] = fixed.map((component) => ({
    input: component,
    fullAmountMinor: component.amountMinor,
  }))

  for (const component of percentage) {
    let baseMinor = 0
    switch (component.percentageBase) {
      case 'BASIC':
        baseMinor = basicMinor
        break
      case 'GROSS':
      case 'CTC':
        baseMinor = fixedEarningsMinor
        break
      case 'COMPONENT':
        baseMinor = component.baseComponentCode ? (fixedByCode.get(component.baseComponentCode) ?? 0) : 0
        break
      default:
        baseMinor = 0
        break
    }
    resolved.push({ input: component, fullAmountMinor: percentOfMinor(baseMinor, component.percentage) })
  }

  return resolved.sort((a, b) => a.input.displayOrder - b.input.displayOrder || a.input.code.localeCompare(b.input.code))
}

/**
 * Scales every component so the structure totals the employee's override amount.
 *
 * This is what lets one structure serve many employees: the shape of the
 * breakdown is shared, the value is per-employee.
 */
function applyOverride(resolved: ResolvedComponent[], overrideTotalMinor: Minor | null): ResolvedComponent[] {
  if (overrideTotalMinor === null) return resolved

  const earningsTotal = resolved
    .filter((entry) => entry.input.componentType === 'EARNING')
    .reduce((total, entry) => total + entry.fullAmountMinor, 0)

  if (earningsTotal <= 0) {
    // Nothing to scale against: put the whole override on the first earning, or
    // create the value on BASIC if the structure has no earning at all.
    const firstEarning = resolved.find((entry) => entry.input.componentType === 'EARNING')
    if (!firstEarning) return resolved
    return resolved.map((entry) =>
      entry === firstEarning ? { ...entry, fullAmountMinor: overrideTotalMinor } : entry,
    )
  }

  const factor = overrideTotalMinor / earningsTotal
  const scaled = resolved.map((entry) =>
    entry.input.componentType === 'EARNING'
      ? { ...entry, fullAmountMinor: multiplyMinor(entry.fullAmountMinor, factor) }
      : entry,
  )

  // Rounding each component independently can drift by a paisa or two; the
  // difference is absorbed by the largest earning so the total is exact.
  const scaledTotal = scaled
    .filter((entry) => entry.input.componentType === 'EARNING')
    .reduce((total, entry) => total + entry.fullAmountMinor, 0)
  const drift = overrideTotalMinor - scaledTotal

  if (drift !== 0) {
    let largest: ResolvedComponent | null = null
    for (const entry of scaled) {
      if (entry.input.componentType !== 'EARNING') continue
      if (!largest || entry.fullAmountMinor > largest.fullAmountMinor) largest = entry
    }
    if (largest) largest.fullAmountMinor += drift
  }

  return scaled
}

/**
 * What each component of a structure is worth over a full period, before any
 * attendance is applied.
 *
 * Payroll goes on to prorate these; a document that quotes the agreed wage
 * rather than a month's pay - the Letter of Appointment - wants them as they
 * are, and should not have to repeat the percentage and override arithmetic to
 * get them.
 */
export function resolveFullAmounts(
  components: ComponentInput[],
  overrideTotalMinor: Minor | null,
): { code: string; name: string; componentType: ComponentType; amountMinor: Minor }[] {
  return applyOverride(resolveComponents(components), overrideTotalMinor).map((entry) => ({
    code: entry.input.code,
    name: entry.input.name,
    componentType: entry.input.componentType,
    amountMinor: entry.fullAmountMinor,
  }))
}

// ---------------------------------------------------------------------------
// Statutory contributions
// ---------------------------------------------------------------------------

function roundToDecimals(minor: Minor, decimals: number): Minor {
  if (decimals >= 2) return minor
  const factor = decimals === 0 ? 100 : 10
  return roundHalfUp(minor / factor) * factor
}

const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-08-15" -> "15 Aug 2026". */
function formatDayMonthYear(date: IsoDate): string {
  const [year, month, day] = date.split('-')
  return `${Number(day)} ${MONTH_ABBREVIATIONS[Number(month) - 1] ?? month} ${year}`
}

/**
 * Rounds up to the next whole rupee: any paise at all makes it a full rupee
 * (4.01 -> 5, 4.88 -> 5, 5.00 stays 5). ESI is rounded this way on both sides.
 */
function ceilToRupee(minor: Minor): Minor {
  return Math.ceil(minor / 100) * 100
}

/** The days in a standard month, for judging a daily-rated employee's ESI eligibility. */
const ESI_STANDARD_MONTH_DAYS = 26

/**
 * The wage ESI eligibility is judged on: what the structure pays for a standard
 * month, never what this month's attendance happened to earn. That is the
 * monthly gross for a monthly structure, and 26 days at the daily rate for a
 * daily one. Judged on actual earnings, a few extra days worked would push an
 * employee over the limit and out of ESI, and a short month would pull one who
 * is over it back in.
 */
function esiEligibilityWage(resolved: ResolvedComponent[], salaryBasis: 'MONTHLY' | 'DAILY'): Minor {
  let wageMinor = 0
  for (const entry of resolved) {
    if (entry.input.componentType !== 'EARNING') continue
    // A daily structure pays a prorated component per day and any other once
    // per period, same as the proration in calculatePayrollItem.
    wageMinor +=
      salaryBasis === 'DAILY' && entry.input.prorate
        ? multiplyMinor(entry.fullAmountMinor, ESI_STANDARD_MONTH_DAYS)
        : entry.fullAmountMinor
  }
  return wageMinor
}

/**
 * One day's salary, the base of an overtime rate of "one day's salary / n": the
 * structure's prorated earnings at the same daily rate its proration uses -
 * the per-day amounts of a daily structure, or a monthly structure's earnings
 * over the payable days basis.
 */
function daySalaryMinor(resolved: ResolvedComponent[], salaryBasis: 'MONTHLY' | 'DAILY', payableDaysBasis: number): Minor {
  let dayMinor = 0
  for (const entry of resolved) {
    if (entry.input.componentType !== 'EARNING' || !entry.input.prorate) continue
    dayMinor += entry.fullAmountMinor
  }
  return salaryBasis === 'MONTHLY' ? prorateMinor(dayMinor, 1, payableDaysBasis) : dayMinor
}

/**
 * One day's salary for a structure, outside a payroll run: what the overtime
 * entry screen shows an entry will be worth before payroll pays it.
 */
export function overtimeDaySalaryMinor(
  components: ComponentInput[],
  overrideTotalMinor: Minor | null,
  salaryBasis: 'MONTHLY' | 'DAILY',
  payableDaysBasis: number,
): Minor {
  return daySalaryMinor(applyOverride(resolveComponents(components), overrideTotalMinor), salaryBasis, payableDaysBasis)
}

/** What hours recorded at one rate pay, given one day's salary for a "day's salary / n" rate. */
export function overtimePayMinor(overtime: OvertimeInput, dayRateMinor: Minor): Minor {
  if (overtime.basis === 'CUSTOM') return multiplyMinor(overtime.ratePerHourMinor ?? 0, overtime.hours)
  const divisor = overtime.dayDivisor ?? 0
  // Hours x day / n in one step, so n hours pay exactly one day's salary.
  return divisor > 0 ? multiplyMinor(dayRateMinor, overtime.hours / divisor) : 0
}

/**
 * `days` of the structure's prorated earnings, component by component at the
 * rate proration uses: the per-day amount of a daily structure, or a monthly
 * one's amount over the payable days basis. `include` narrows the components.
 */
function earningsForDaysMinor(
  resolved: ResolvedComponent[],
  salaryBasis: 'MONTHLY' | 'DAILY',
  days: number,
  payableDaysBasis: number,
  include: (component: ComponentInput) => boolean,
): Minor {
  let totalMinor = 0
  for (const entry of resolved) {
    if (entry.input.componentType !== 'EARNING' || !entry.input.prorate || !include(entry.input)) continue
    totalMinor +=
      salaryBasis === 'DAILY'
        ? multiplyMinor(entry.fullAmountMinor, days)
        : prorateMinor(entry.fullAmountMinor, days, payableDaysBasis)
  }
  return totalMinor
}

/**
 * What working a holiday comes to, outside a payroll run: the day's own wage -
 * the holiday paid as a day worked, so with every component - and the extra
 * pay working it earns on a holiday that offers it - the Holiday Work Pay line,
 * without the components left out of holiday pay. `days` is 1 for a full day
 * and 0.5 for a half day.
 */
export function holidayWorkAmountsMinor(
  components: ComponentInput[],
  overrideTotalMinor: Minor | null,
  salaryBasis: 'MONTHLY' | 'DAILY',
  payableDaysBasis: number,
  days: number,
): { dayWageMinor: Minor; extraPayMinor: Minor } {
  const resolved = applyOverride(resolveComponents(components), overrideTotalMinor)
  return {
    dayWageMinor: earningsForDaysMinor(resolved, salaryBasis, days, payableDaysBasis, () => true),
    extraPayMinor: earningsForDaysMinor(resolved, salaryBasis, days, payableDaysBasis, (component) => component.holidayExtraPay),
  }
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

export function calculatePayrollItem(input: CalculatorInput): CalculatorOutput {
  const warnings: string[] = []
  const attendance = summariseAttendance(input.days, input.policy)

  if (attendance.unmarkedDays > 0) {
    warnings.push(
      `${attendance.unmarkedDays} working day(s) have no attendance record and were treated as unpaid.`,
    )
  }
  if (attendance.calendarDays === 0) {
    warnings.push('The employee was not employed during any part of this payroll period.')
  }

  const resolved = applyOverride(resolveComponents(input.components), input.overrideTotalMinor)

  // ------------------------------------------------------------------
  // Structure components, prorated by attendance.
  // ------------------------------------------------------------------
  const components: ComponentResult[] = []
  let grossEarningsMinor = 0
  let structureDeductionsMinor = 0
  let employerContributionsMinor = 0
  // The statutory wage is the structure's own gross earnings plus holiday work
  // pay (added below) - adjustments never count toward it.
  let structureGrossMinor = 0
  let holidayWorkMinor = 0
  let basicMinor = 0

  for (const entry of resolved) {
    const component = entry.input
    let amountMinor: Minor
    // A holiday is paid without the components left out of holiday pay (SKT's
    // Special Allowance): they are paid only for the days worked or on leave.
    // A worked holiday is a day worked, so it keeps them.
    const componentPaidDays = component.holidayExtraPay
      ? attendance.paidDays
      : roundDays(attendance.paidDays - attendance.paidHolidayDays)

    if (input.employee.salaryBasis === 'DAILY') {
      // A daily structure holds per-day amounts: rate x paid days (plan section 22).
      amountMinor = component.prorate
        ? multiplyMinor(entry.fullAmountMinor, componentPaidDays)
        : entry.fullAmountMinor
    } else if (component.prorate) {
      amountMinor = prorateMinor(entry.fullAmountMinor, componentPaidDays, attendance.payableDaysBasis)
    } else {
      amountMinor = entry.fullAmountMinor
    }

    components.push({
      code: component.code,
      name: component.name,
      componentType: component.componentType,
      calculationType: component.calculationType,
      source: 'SALARY_STRUCTURE',
      fullAmountMinor: entry.fullAmountMinor,
      amountMinor,
      percentage: component.calculationType === 'PERCENTAGE' ? component.percentage : null,
      taxable: component.taxable,
      displayOrder: component.displayOrder,
      referenceId: null,
      notes: null,
    })

    if (component.componentType === 'EARNING') {
      grossEarningsMinor += amountMinor
      structureGrossMinor += amountMinor
      if (component.code === 'BASIC') basicMinor += amountMinor
    } else if (component.componentType === 'DEDUCTION') {
      structureDeductionsMinor += amountMinor
    } else {
      employerContributionsMinor += amountMinor
    }
  }

  // ------------------------------------------------------------------
  // Bonuses and PL Wages are not part of salary: each is paid separately and
  // marked paid in its own module (bonuses.module.ts, pl-wages.module.ts).
  //
  // PSR overtime pay: hours x rate (plan: OT for PSR is paid, not days off -
  // the opposite of a Supply employee's conversion). Each entry chose its rate
  // when it was recorded: one day's salary / n hours - a day being the
  // structure's earnings at the same daily rate its proration uses, as for
  // holiday work pay - or a custom amount per hour. It is added straight to net
  // pay after the deductions, like Other Credits: it is not part of gross or the
  // statutory wage, so no PF, ESI or other deduction is taken from it.
  // ------------------------------------------------------------------
  const dayRateMinor = daySalaryMinor(resolved, input.employee.salaryBasis, attendance.payableDaysBasis)

  let overtimeAmountMinor = 0
  let unpaidOvertimeHours = 0
  const overtimeNotes: string[] = []
  for (const overtime of input.overtime) {
    if (overtime.hours <= 0) continue
    const amountMinor = overtimePayMinor(overtime, dayRateMinor)
    if (overtime.basis === 'CUSTOM') {
      overtimeNotes.push(`${overtime.hours} hour(s) at ${(overtime.ratePerHourMinor ?? 0) / 100}/hour`)
    } else {
      const divisor = overtime.dayDivisor ?? 0
      overtimeNotes.push(
        `${overtime.hours} hour(s) at ${divisor > 0 ? (dayRateMinor / 100 / divisor).toFixed(2) : 0}/hour (one day's salary ${dayRateMinor / 100} / ${divisor})`,
      )
    }
    if (amountMinor > 0) overtimeAmountMinor += amountMinor
    else unpaidOvertimeHours += overtime.hours
  }

  if (overtimeAmountMinor > 0) {
    components.push({
      code: 'OVERTIME',
      name: 'Overtime',
      componentType: 'CREDIT',
      calculationType: 'FIXED',
      source: 'OVERTIME',
      fullAmountMinor: overtimeAmountMinor,
      amountMinor: overtimeAmountMinor,
      percentage: null,
      taxable: true,
      displayOrder: 550,
      referenceId: null,
      notes: overtimeNotes.join('; '),
    })
  }
  if (unpaidOvertimeHours > 0) {
    warnings.push(`${unpaidOvertimeHours} overtime hour(s) are recorded but their rate works out to zero; they were not paid.`)
  }

  // ------------------------------------------------------------------
  // Holiday work pay. A holiday flagged "extra pay if worked" is already paid
  // through the paid days; anyone marked present on it also earns that day's
  // work, i.e. one more day of pay (holiday + work). One day is the salary
  // structure's earnings at the same daily rate its proration uses, so it agrees
  // with the rest of the payslip. It is wages earned in the month, so it counts
  // toward gross earnings and toward the PF and ESI wage (unlike overtime). A
  // holiday worked for half a day earns half of that: its worked half is paid
  // through the paid days, and the extra pay is half a day more.
  // A component switched out of holiday extra pay (e.g. a special allowance
  // paid for the month's days only) is left out of that extra day.
  // ------------------------------------------------------------------
  const holidaysWorked = input.days.filter(
    (day) =>
      day.isEmployed &&
      (day.status === 'PRESENT' || day.status === 'HALF_DAY_LEAVE') &&
      day.dayKind === 'HOLIDAY' &&
      day.holidayExtraPay,
  )
  const holidayWorkedDays = holidaysWorked.reduce((total, day) => total + (day.status === 'PRESENT' ? 1 : 0.5), 0)
  if (holidayWorkedDays > 0) {
    holidayWorkMinor = earningsForDaysMinor(
      resolved,
      input.employee.salaryBasis,
      holidayWorkedDays,
      attendance.payableDaysBasis,
      (component) => component.holidayExtraPay,
    )
    if (holidayWorkMinor > 0) {
      grossEarningsMinor += holidayWorkMinor
      components.push({
        code: 'HOLIDAY_WORK',
        name: 'Holiday Work Pay',
        componentType: 'EARNING',
        calculationType: 'FIXED',
        source: 'HOLIDAY_WORK',
        fullAmountMinor: holidayWorkMinor,
        amountMinor: holidayWorkMinor,
        percentage: null,
        taxable: true,
        displayOrder: 560,
        referenceId: null,
        // Which holidays were worked, so the payslip line explains itself.
        notes: `Worked ${holidaysWorked
          .map((day) => {
            const label = day.holidayName ? `${day.holidayName} (${formatDayMonthYear(day.date)})` : formatDayMonthYear(day.date)
            return day.status === 'HALF_DAY_LEAVE' ? `${label} - half day` : label
          })
          .join(', ')}`,
      })
    }
  }

  // ------------------------------------------------------------------
  // Statutory contributions: PF is deducted on the structure's wage capped at
  // the structure's PF wage ceiling. Employee PF, the employer share and EPS are
  // each rounded to the nearest whole rupee (.5 and above up, below .5 down), and
  // EPF is the remainder, so all three parts are whole rupees. ESI applies,
  // on both sides, only when a standard month's wage (esiEligibilityWage) is at
  // or below the structure's ESI limit; it is then deducted on the month's wage
  // capped at that limit, and is always rounded UP to the next whole rupee.
  // Neither is rounded into the net: net salary is gross less these whole-rupee
  // amounts, so it keeps whatever paise the prorated earnings carry.
  // ------------------------------------------------------------------
  // PF and ESI are worked out on the structure's earnings plus holiday work pay.
  // ESI *eligibility* looks at the structure's standard month alone, so extra
  // days or a worked holiday cannot push someone over the ESI limit and drop
  // them out of the scheme - the part of the wage above the limit is simply not
  // charged ESI.
  const statutoryWageMinor = structureGrossMinor + holidayWorkMinor
  let statutoryDeductionsMinor = 0
  let pfWageMinor = 0
  let pfWageCeilingMinor = 0
  let esiWageMinor = 0

  if (input.pf.applicable && statutoryWageMinor > 0) {
    pfWageCeilingMinor = input.pf.wageLimitMinor
    pfWageMinor =
      input.pf.wageLimitMinor > 0 ? minMinor(statutoryWageMinor, input.pf.wageLimitMinor) : statutoryWageMinor
    // EPFO contributions are always whole rupees, never paise, on every side.
    const employeeMinor = roundToDecimals(percentOfMinor(pfWageMinor, input.pf.employeeRate), 0)
    const employerMinor = roundToDecimals(percentOfMinor(pfWageMinor, input.pf.employerRate), 0)

    if (employeeMinor > 0) {
      statutoryDeductionsMinor += employeeMinor
      components.push({
        code: 'PF_EMPLOYEE',
        name: 'Provident Fund (Employee)',
        componentType: 'DEDUCTION',
        calculationType: 'PERCENTAGE',
        source: 'STATUTORY',
        fullAmountMinor: employeeMinor,
        amountMinor: employeeMinor,
        percentage: input.pf.employeeRate,
        taxable: false,
        displayOrder: 700,
        referenceId: null,
        notes: `PF wage ${pfWageMinor / 100}`,
      })
    }
    if (employerMinor > 0) {
      employerContributionsMinor += employerMinor

      // The employer's share splits into the Pension Scheme (EPS) and EPF, same
      // as an EPFO return. The share and EPS are each rounded to the nearest
      // rupee; EPF is what is left, so EPS + EPF always equals the employer
      // share. Rounding EPF on its own would push a 15,000 wage to 1,801
      // (1,250 + 551) instead of 1,800 and disagree with the EPFO return.
      const epsRate = input.pf.epsRate ?? 0
      const epsMinor = epsRate > 0 ? minMinor(roundToDecimals(percentOfMinor(pfWageMinor, epsRate), 0), employerMinor) : 0
      const epfMinor = employerMinor - epsMinor

      if (epsMinor > 0) {
        components.push({
          code: 'PF_EMPLOYER_EPS',
          name: 'Provident Fund (Employer - EPS)',
          componentType: 'EMPLOYER_CONTRIBUTION',
          calculationType: 'PERCENTAGE',
          source: 'STATUTORY',
          fullAmountMinor: epsMinor,
          amountMinor: epsMinor,
          percentage: epsRate,
          taxable: false,
          displayOrder: 701,
          referenceId: null,
          notes: null,
        })
      }
      if (epfMinor > 0) {
        components.push({
          code: 'PF_EMPLOYER_EPF',
          name: 'Provident Fund (Employer - EPF)',
          componentType: 'EMPLOYER_CONTRIBUTION',
          calculationType: 'PERCENTAGE',
          source: 'STATUTORY',
          fullAmountMinor: epfMinor,
          amountMinor: epfMinor,
          percentage: input.pf.employerRate - epsRate,
          taxable: false,
          displayOrder: 702,
          referenceId: null,
          notes: null,
        })
      }
    }
  }

  if (
    input.esi.applicable &&
    structureGrossMinor > 0 &&
    (input.esi.wageLimitMinor <= 0 ||
      esiEligibilityWage(resolved, input.employee.salaryBasis) <= input.esi.wageLimitMinor)
  ) {
    esiWageMinor =
      input.esi.wageLimitMinor > 0 ? minMinor(statutoryWageMinor, input.esi.wageLimitMinor) : statutoryWageMinor
    const employeeMinor = ceilToRupee(percentOfMinor(esiWageMinor, input.esi.employeeRate))
    const employerMinor = ceilToRupee(percentOfMinor(esiWageMinor, input.esi.employerRate))

    if (employeeMinor > 0) {
      statutoryDeductionsMinor += employeeMinor
      components.push({
        code: 'ESI_EMPLOYEE',
        name: 'ESI (Employee)',
        componentType: 'DEDUCTION',
        calculationType: 'PERCENTAGE',
        source: 'STATUTORY',
        fullAmountMinor: employeeMinor,
        amountMinor: employeeMinor,
        percentage: input.esi.employeeRate,
        taxable: false,
        displayOrder: 710,
        referenceId: null,
        notes: `ESI wage ${esiWageMinor / 100}`,
      })
    }
    if (employerMinor > 0) {
      employerContributionsMinor += employerMinor
      components.push({
        code: 'ESI_EMPLOYER',
        name: 'ESI (Employer)',
        componentType: 'EMPLOYER_CONTRIBUTION',
        calculationType: 'PERCENTAGE',
        source: 'STATUTORY',
        fullAmountMinor: employerMinor,
        amountMinor: employerMinor,
        percentage: input.esi.employerRate,
        taxable: false,
        displayOrder: 711,
        referenceId: null,
        notes: null,
      })
    }
  }

  // ------------------------------------------------------------------
  // Tax (P.Tax): a fixed amount worked out by the tax module for a chosen month.
  // ------------------------------------------------------------------
  if (input.tax && input.tax.amountMinor > 0) {
    statutoryDeductionsMinor += input.tax.amountMinor
    components.push({
      code: 'PTAX',
      name: 'P.Tax',
      componentType: 'DEDUCTION',
      calculationType: 'FIXED',
      source: 'STATUTORY',
      fullAmountMinor: input.tax.amountMinor,
      amountMinor: input.tax.amountMinor,
      percentage: null,
      taxable: false,
      displayOrder: 750,
      referenceId: input.tax.id,
      notes: input.tax.note,
    })
  }

  // ------------------------------------------------------------------
  // P.Tax on exit: the slab for the half-year's wages so far - the
  // structure earnings of its earlier months and of this one, the same
  // wages the tax report totals. A line of its own, beside any tax set
  // from the report for the half-year that has just ended.
  // ------------------------------------------------------------------
  let exitTax: CalculatorOutput['exitTax'] = null
  if (input.exitTax) {
    const wageBaseMinor = input.exitTax.priorWagesMinor + structureGrossMinor
    const amountMinor = taxForWagesMinor(wageBaseMinor, input.exitTax.slabs)
    exitTax = { id: input.exitTax.id, wageBaseMinor, amountMinor }

    if (amountMinor > 0) {
      statutoryDeductionsMinor += amountMinor
      components.push({
        code: 'PTAX',
        name: 'P.Tax (on exit)',
        componentType: 'DEDUCTION',
        calculationType: 'FIXED',
        source: 'STATUTORY',
        fullAmountMinor: amountMinor,
        amountMinor,
        percentage: null,
        taxable: false,
        displayOrder: 751,
        referenceId: input.exitTax.id,
        notes: `On wages ${wageBaseMinor / 100} for ${input.exitTax.periodFrom} to ${input.exitTax.periodTo}`,
      })
    }
  }

  // ------------------------------------------------------------------
  // Labour Welfare Fund: a fixed amount set by the lwf module for a chosen
  // month. Only the employee's share ever touches payroll - the employer's
  // matching share is tracked in the lwf module alone, never deducted from
  // anyone's pay.
  // ------------------------------------------------------------------
  if (input.lwf && input.lwf.amountMinor > 0) {
    statutoryDeductionsMinor += input.lwf.amountMinor
    components.push({
      code: 'LWF_EMPLOYEE',
      name: 'Labour Welfare Fund',
      componentType: 'DEDUCTION',
      calculationType: 'FIXED',
      source: 'STATUTORY',
      fullAmountMinor: input.lwf.amountMinor,
      amountMinor: input.lwf.amountMinor,
      percentage: null,
      taxable: false,
      displayOrder: 760,
      referenceId: input.lwf.id,
      notes: input.lwf.note,
    })
  }

  // ------------------------------------------------------------------
  // Adjustments carried from a locked run (plan section 33).
  // ------------------------------------------------------------------
  let adjustmentEarningsMinor = 0
  let adjustmentDeductionsMinor = 0
  let totalCreditsMinor = 0

  for (const adjustment of input.adjustments) {
    if (adjustment.amountMinor === 0) continue

    components.push({
      code: adjustment.code,
      name: adjustment.name,
      componentType: adjustment.componentType,
      calculationType: 'FIXED',
      source: 'ADJUSTMENT',
      fullAmountMinor: adjustment.amountMinor,
      amountMinor: adjustment.amountMinor,
      percentage: null,
      taxable: false,
      displayOrder: 900,
      referenceId: adjustment.id,
      notes: adjustment.reason,
    })

    if (adjustment.componentType === 'EARNING') adjustmentEarningsMinor += adjustment.amountMinor
    else if (adjustment.componentType === 'DEDUCTION') adjustmentDeductionsMinor += adjustment.amountMinor
    else if (adjustment.componentType === 'CREDIT') totalCreditsMinor += adjustment.amountMinor
    else employerContributionsMinor += adjustment.amountMinor
  }

  grossEarningsMinor += adjustmentEarningsMinor

  const totalDeductionsMinor = addMinor(
    structureDeductionsMinor,
    statutoryDeductionsMinor,
    adjustmentDeductionsMinor,
  )

  // Overtime and credits go straight to net pay, after the deductions, so
  // none is taken from them.
  let netSalaryMinor = grossEarningsMinor - totalDeductionsMinor + overtimeAmountMinor + totalCreditsMinor
  netSalaryMinor = roundToDecimals(netSalaryMinor, input.policy.netRoundingDecimals)

  if (netSalaryMinor < 0) {
    warnings.push(
      'Deductions exceed earnings for this employee, producing a negative net salary. Review the deductions before approving.',
    )
  }

  components.sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code))

  return {
    employeeId: input.employee.id,
    attendance,
    components,
    grossEarningsMinor,
    totalDeductionsMinor,
    totalOvertimeMinor: overtimeAmountMinor,
    totalCreditsMinor,
    employerContributionsMinor,
    pfWageMinor,
    pfWageCeilingMinor,
    esiWageMinor,
    netSalaryMinor,
    exitTax,
    warnings,
  }
}

/** The tax for a wage: the first slab whose limit it does not exceed. No slabs at all means no tax. */
export function taxForWagesMinor(wagesMinor: Minor, slabs: TaxSlabInput[]): Minor {
  for (const slab of slabs) {
    if (slab.upToMinor === null || wagesMinor <= slab.upToMinor) return slab.taxMinor
  }
  return 0
}
