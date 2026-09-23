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
}

export type ComponentType = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
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
  displayOrder: number
}

export interface BonusInput {
  id: string
  code: string
  name: string
  amountType: 'FIXED_AMOUNT' | 'PERCENTAGE'
  amountMinor: Minor
  percentage: number
  taxable: boolean
}

/** The tax set to be deducted from this employee's pay this month (see the tax module). */
export interface TaxInput {
  id: string
  amountMinor: Minor
  /** How it was worked out, shown beside the deduction. */
  note: string | null
}

/** The employee's Labour Welfare Fund contribution due this month (see the lwf module). */
export interface LwfInput {
  id: string
  amountMinor: Minor
  note: string | null
}

/** The employee's PL Wages credit released into this month's payroll (see the pl-wages module). */
export interface PlWagesInput {
  id: string
  amountMinor: Minor
  note: string | null
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
   * applied. ESI: the scheme applies, on both sides, only when the wage is at
   * or below this limit - the wage itself is not capped. Zero means no cap
   * (or, for ESI, no limit: it always applies).
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
   * PSR overtime for the period: hours worked and the per-hour rate to pay them
   * at. Null for a Supply employee, whose overtime converts to extra weekly offs
   * instead (overtime.service.ts) and never touches payroll money.
   */
  overtime: { hours: number; rateMinor: Minor } | null
  /**
   * Per-employee total that replaces the structure total: monthly gross for a
   * MONTHLY structure, daily rate for a DAILY one. Components are scaled
   * proportionally so the breakdown still adds up.
   */
  overrideTotalMinor: Minor | null
  bonuses: BonusInput[]
  /** Null when no tax is to be deducted from this employee this month. */
  tax: TaxInput | null
  /** Null when no Labour Welfare Fund contribution is due from this employee this month. */
  lwf: LwfInput | null
  /** Null when no PL Wages credit is released into this employee's pay this month. */
  plWages: PlWagesInput | null
  adjustments: AdjustmentInput[]
  /** PF is deducted on the structure's wage, capped at `pf.wageLimitMinor`. */
  pf: StatutoryInput
  /** ESI applies only when the structure's wage is at or below `esi.wageLimitMinor`. */
  esi: StatutoryInput
  policy: PolicyInput
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ComponentSource =
  | 'SALARY_STRUCTURE'
  | 'BONUS'
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
  /** The denominator used to prorate a monthly salary. */
  payableDaysBasis: number
}

export interface CalculatorOutput {
  employeeId: string
  attendance: AttendanceSummary
  components: ComponentResult[]
  grossEarningsMinor: Minor
  totalBonusMinor: Minor
  totalDeductionsMinor: Minor
  employerContributionsMinor: Minor
  /** The wage PF/ESI were actually calculated on this run (0 when not applicable). */
  pfWageMinor: Minor
  /** The ceiling that was in force for this run (0 when PF is not applicable). */
  pfWageCeilingMinor: Minor
  esiWageMinor: Minor
  netSalaryMinor: Minor
  /** Non-fatal conditions the reviewer should see before approving. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

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
        // The worked half plus whatever the policy grants for the leave half.
        dayPaid = day.leaveIsPaid ? policy.halfDayPaidFraction : policy.halfDayUnpaidFraction
        if (day.leaveIsPaid) paidLeaveDays += 0.5
        else unpaidLeaveDays += 0.5
        break

      case 'HOLIDAY':
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
  }

  let payableDaysBasis: number
  let effectivePaidDays: number

  switch (policy.paidDaysBasis) {
    case 'WORKING_DAYS':
      payableDaysBasis = workingDays
      effectivePaidDays = workingPaidDays
      break
    case 'ACTUAL_ATTENDANCE_DAYS':
      payableDaysBasis = attendanceDays
      effectivePaidDays = attendancePaidDays
      break
    case 'CALENDAR_DAYS':
    default:
      payableDaysBasis = calendarDays
      effectivePaidDays = paidDays
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
  // pay (added below) - bonuses and overtime never count toward it.
  let structureGrossMinor = 0
  let holidayWorkMinor = 0
  let basicMinor = 0

  for (const entry of resolved) {
    const component = entry.input
    let amountMinor: Minor

    if (input.employee.salaryBasis === 'DAILY') {
      // A daily structure holds per-day amounts: rate x paid days (plan section 22).
      amountMinor = component.prorate
        ? multiplyMinor(entry.fullAmountMinor, attendance.paidDays)
        : entry.fullAmountMinor
    } else if (component.prorate) {
      amountMinor = prorateMinor(entry.fullAmountMinor, attendance.paidDays, attendance.payableDaysBasis)
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
  // Bonuses become earning components (plan section 25).
  // ------------------------------------------------------------------
  let totalBonusMinor = 0
  for (const bonus of input.bonuses) {
    const amountMinor =
      bonus.amountType === 'PERCENTAGE' ? percentOfMinor(grossEarningsMinor, bonus.percentage) : bonus.amountMinor
    if (amountMinor === 0) continue

    totalBonusMinor += amountMinor
    components.push({
      code: bonus.code,
      name: bonus.name,
      componentType: 'EARNING',
      calculationType: bonus.amountType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED',
      source: 'BONUS',
      fullAmountMinor: amountMinor,
      amountMinor,
      percentage: bonus.amountType === 'PERCENTAGE' ? bonus.percentage : null,
      taxable: bonus.taxable,
      displayOrder: 500,
      referenceId: bonus.id,
      notes: null,
    })
  }

  // Bonuses count toward gross earnings but not toward the statutory wage, which
  // is derived from the salary structure alone.
  grossEarningsMinor += totalBonusMinor

  // ------------------------------------------------------------------
  // PL Wages: a past year's earned-leave wage credit released into this month's
  // pay by the pl-wages module. Like a bonus, it counts toward gross earnings
  // but never toward the statutory wage.
  // ------------------------------------------------------------------
  if (input.plWages && input.plWages.amountMinor > 0) {
    grossEarningsMinor += input.plWages.amountMinor
    components.push({
      code: 'PL_WAGES',
      name: 'PL Wages',
      componentType: 'EARNING',
      calculationType: 'FIXED',
      source: 'STATUTORY',
      fullAmountMinor: input.plWages.amountMinor,
      amountMinor: input.plWages.amountMinor,
      percentage: null,
      taxable: true,
      displayOrder: 570,
      referenceId: input.plWages.id,
      notes: input.plWages.note,
    })
  }

  // ------------------------------------------------------------------
  // PSR overtime pay: hours x rate, as a plain earning (plan: OT for PSR is
  // salary, not days off - the opposite of a Supply employee's conversion).
  // Like bonuses, it counts toward gross earnings but not the statutory wage.
  // ------------------------------------------------------------------
  if (input.overtime && input.overtime.hours > 0 && input.overtime.rateMinor > 0) {
    const overtimeAmountMinor = multiplyMinor(input.overtime.rateMinor, input.overtime.hours)
    grossEarningsMinor += overtimeAmountMinor
    components.push({
      code: 'OVERTIME',
      name: 'Overtime',
      componentType: 'EARNING',
      calculationType: 'FIXED',
      source: 'OVERTIME',
      fullAmountMinor: overtimeAmountMinor,
      amountMinor: overtimeAmountMinor,
      percentage: null,
      taxable: true,
      displayOrder: 550,
      referenceId: null,
      notes: `${input.overtime.hours} hour(s) at ${input.overtime.rateMinor / 100}/hour`,
    })
  }

  // ------------------------------------------------------------------
  // Holiday work pay. A holiday flagged "extra pay if worked" is already paid
  // through the paid days; anyone marked present on it also earns that day's
  // work, i.e. one more day of pay (holiday + work). One day is the salary
  // structure's earnings at the same daily rate its proration uses, so it agrees
  // with the rest of the payslip. It is wages earned in the month, so it counts
  // toward gross earnings and toward the PF and ESI wage (unlike overtime and
  // bonuses).
  // ------------------------------------------------------------------
  const holidaysWorked = input.days.filter(
    (day) => day.isEmployed && day.status === 'PRESENT' && day.dayKind === 'HOLIDAY' && day.holidayExtraPay,
  )
  const holidayWorkedDays = holidaysWorked.length
  if (holidayWorkedDays > 0) {
    for (const entry of resolved) {
      if (entry.input.componentType !== 'EARNING' || !entry.input.prorate) continue
      holidayWorkMinor +=
        input.employee.salaryBasis === 'DAILY'
          ? multiplyMinor(entry.fullAmountMinor, holidayWorkedDays)
          : prorateMinor(entry.fullAmountMinor, holidayWorkedDays, attendance.payableDaysBasis)
    }
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
          .map((day) => (day.holidayName ? `${day.holidayName} (${formatDayMonthYear(day.date)})` : formatDayMonthYear(day.date)))
          .join(', ')}`,
      })
    }
  }

  // ------------------------------------------------------------------
  // Statutory contributions: PF is deducted on the structure's wage capped at
  // the structure's PF wage ceiling. Employee PF, the employer share and EPS are
  // each rounded to the nearest whole rupee (.5 and above up, below .5 down), and
  // EPF is the remainder, so all three parts are whole rupees. ESI applies,
  // on both sides, on the full wage, but only when the structure's wage is at or
  // below the structure's ESI limit, and is always rounded UP to the next whole rupee.
  // Neither is rounded into the net: net salary is gross less these whole-rupee
  // amounts, so it keeps whatever paise the prorated earnings carry.
  // ------------------------------------------------------------------
  // PF and ESI are worked out on the structure's earnings plus holiday work pay.
  // ESI *eligibility* still looks at the structure alone, so a month with a
  // worked holiday cannot by itself push someone over the ESI limit and drop
  // them out of the scheme.
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
    (input.esi.wageLimitMinor <= 0 || structureGrossMinor <= input.esi.wageLimitMinor)
  ) {
    esiWageMinor = statutoryWageMinor
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
    else employerContributionsMinor += adjustment.amountMinor
  }

  grossEarningsMinor += adjustmentEarningsMinor

  const totalDeductionsMinor = addMinor(
    structureDeductionsMinor,
    statutoryDeductionsMinor,
    adjustmentDeductionsMinor,
  )

  let netSalaryMinor = grossEarningsMinor - totalDeductionsMinor
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
    totalBonusMinor,
    totalDeductionsMinor,
    employerContributionsMinor,
    pfWageMinor,
    pfWageCeilingMinor,
    esiWageMinor,
    netSalaryMinor,
    warnings,
  }
}
