import { pool, queryRows } from '../../database/pool.js'
import { countDaysBetween, payCycleContaining, PAYROLL_CYCLE_CUTOFF_DAY, type IsoDate } from '../../utils/dates.js'
import { roundHalfUp, toMajor, toMinor, type Minor } from '../../utils/money.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import {
  holidayWorkAmountsMinor,
  overtimeDaySalaryMinor,
  overtimePayMinor,
  type ComponentInput,
  type DayInput,
} from '../payroll/payroll.calculator.js'
import { toComponentInputs } from '../payroll/payroll.service.js'
import * as salaryRepository from '../salary/salary.repository.js'

/**
 * Amounts for the overtime and holiday reports, worked out with payroll's own
 * arithmetic (payroll.calculator.ts) rather than re-derived in SQL, so a report
 * agrees with the payslips.
 *
 * Both rest on one day's salary, which depends on the pay period a date falls
 * in: the payroll run covering it when there is one, else the standard cycle
 * (21st to 20th). Within that period payroll uses the salary structure assigned
 * on its last day, over the days the employee was employed in it.
 */

export type ReportRow = Record<string, unknown>

/** The salary an employee is paid on in one pay period, as calculateRun reads it. */
interface PeriodSalary {
  components: ComponentInput[]
  overrideTotalMinor: Minor | null
  salaryBasis: 'MONTHLY' | 'DAILY'
  /** The days of the period the employee was employed: payroll's proration basis. */
  payableDaysBasis: number
}

interface EmployeeDate {
  employeeId: string
  date: IsoDate
  joiningDate: IsoDate
  exitDate: IsoDate | null
}

/** Reads the employee and the date a row is about; `dateKey` names the row's date. */
function employeeDate(row: ReportRow, dateKey: string): EmployeeDate {
  return {
    employeeId: String(row.employee_id),
    date: row[dateKey] as IsoDate,
    joiningDate: row.joining_date as IsoDate,
    exitDate: (row.exit_date as IsoDate | null) ?? null,
  }
}

function dateSpan(dates: IsoDate[]): { from: IsoDate; to: IsoDate } {
  const sorted = [...dates].sort()
  return { from: sorted[0] as IsoDate, to: sorted[sorted.length - 1] as IsoDate }
}

/**
 * Loads, in a few batch queries, the salary each (employee, date) is paid on,
 * and returns a lookup for it. The lookup gives null when no salary structure
 * is assigned for the period, as payroll then skips the employee.
 */
async function loadPeriodSalaries(
  organizationId: string,
  needs: EmployeeDate[],
): Promise<(need: EmployeeDate) => PeriodSalary | null> {
  if (needs.length === 0) return () => null

  const span = dateSpan(needs.map((need) => need.date))
  const runs = await queryRows<{ period_start: IsoDate; period_end: IsoDate }>(
    pool,
    `SELECT period_start, period_end FROM payroll_runs
      WHERE organization_id = $1 AND period_start <= $3 AND period_end >= $2`,
    [organizationId, span.from, span.to],
  )
  const periodOf = (date: IsoDate): { start: IsoDate; end: IsoDate } => {
    const run = runs.find((entry) => date >= entry.period_start && date <= entry.period_end)
    return run ? { start: run.period_start, end: run.period_end } : payCycleContaining(date, PAYROLL_CYCLE_CUTOFF_DAY)
  }

  // One assignment lookup per period and one load per distinct structure.
  const employeesByPeriodEnd = new Map<IsoDate, Set<string>>()
  for (const need of needs) {
    const end = periodOf(need.date).end
    const ids = employeesByPeriodEnd.get(end) ?? new Set<string>()
    ids.add(need.employeeId)
    employeesByPeriodEnd.set(end, ids)
  }
  const assignments = new Map<string, salaryRepository.SalaryAssignmentRow>()
  for (const [end, ids] of employeesByPeriodEnd) {
    for (const assignment of await salaryRepository.findAssignmentsForDate([...ids], end)) {
      assignments.set(`${end}|${assignment.employee_id}`, assignment)
    }
  }
  const componentsByStructure = new Map<string, { basis: 'MONTHLY' | 'DAILY'; components: ComponentInput[] } | null>()
  for (const assignment of assignments.values()) {
    if (componentsByStructure.has(assignment.salary_structure_id)) continue
    const structure = await salaryRepository.findStructure(assignment.salary_structure_id, organizationId)
    componentsByStructure.set(
      assignment.salary_structure_id,
      structure ? { basis: structure.salary_basis, components: toComponentInputs(structure) } : null,
    )
  }

  return (need) => {
    const period = periodOf(need.date)
    const assignment = assignments.get(`${period.end}|${need.employeeId}`)
    const structure = assignment ? componentsByStructure.get(assignment.salary_structure_id) : null
    if (!assignment || !structure) return null

    const employedFrom = need.joiningDate > period.start ? need.joiningDate : period.start
    const employedTo = need.exitDate !== null && need.exitDate < period.end ? need.exitDate : period.end
    return {
      components: structure.components,
      overrideTotalMinor: assignment.override_amount === null ? null : toMinor(assignment.override_amount),
      salaryBasis: structure.basis,
      payableDaysBasis: employedFrom <= employedTo ? countDaysBetween(employedFrom, employedTo) : 0,
    }
  }
}

/**
 * Overtime report: the rate each entry is paid at and what it comes to. A
 * Supply employee's overtime becomes extra weekly offs instead and is never
 * paid, so it carries no amount.
 */
export async function addOvertimeAmounts(organizationId: string, rows: ReportRow[]): Promise<ReportRow[]> {
  const paid = rows.filter((row) => row.overtime_handling === 'PAID_HOURLY')
  const salaryFor = await loadPeriodSalaries(
    organizationId,
    paid.map((row) => employeeDate(row, 'work_date')),
  )

  return rows.map((row) => {
    if (row.overtime_handling !== 'PAID_HOURLY') {
      return { ...row, rate: 'Extra weekly off', rate_per_hour: null, amount: null }
    }

    const hours = Number(row.hours)
    if (row.rate_basis === 'CUSTOM') {
      const rateMinor = Number(row.rate_per_hour_minor ?? 0)
      return {
        ...row,
        rate: 'Custom rate',
        rate_per_hour: toMajor(rateMinor),
        amount: toMajor(overtimePayMinor({ hours, basis: 'CUSTOM', dayDivisor: null, ratePerHourMinor: rateMinor }, 0)),
      }
    }

    const divisor = Number(row.day_divisor)
    const salary = salaryFor(employeeDate(row, 'work_date'))
    if (!salary) {
      return { ...row, rate: `One day's salary / ${divisor} (no salary structure)`, rate_per_hour: null, amount: null }
    }
    const dayMinor = overtimeDaySalaryMinor(
      salary.components,
      salary.overrideTotalMinor,
      salary.salaryBasis,
      salary.payableDaysBasis,
    )
    return {
      ...row,
      rate: `One day's salary ${toMajor(dayMinor)} / ${divisor}`,
      rate_per_hour: divisor > 0 ? toMajor(roundHalfUp(dayMinor / divisor)) : null,
      amount: toMajor(overtimePayMinor({ hours, basis: 'DAY_SALARY', dayDivisor: divisor, ratePerHourMinor: null }, dayMinor)),
    }
  })
}

/**
 * Holiday report: for each holiday worked, the day's own wage, the extra pay
 * working it earned, and the two together.
 *
 * Extra pay is due only on a holiday that offers it, and only where the
 * employee's calendar keeps the day a holiday - one falling on their weekly off
 * stays a weekly off, as it does in payroll.
 */
export async function addHolidayAmounts(organizationId: string, rows: ReportRow[]): Promise<ReportRow[]> {
  if (rows.length === 0) return rows

  const salaryFor = await loadPeriodSalaries(
    organizationId,
    rows.map((row) => employeeDate(row, 'holiday_date')),
  )
  const span = dateSpan(rows.map((row) => row.holiday_date as IsoDate))
  const calendar = await buildCalendarContext(organizationId, span.from, span.to)

  return rows.map((row) => {
    const salary = salaryFor(employeeDate(row, 'holiday_date'))
    if (!salary) return { ...row, holiday_wage: null, extra_pay: null, total_amount: null }

    const { dayWageMinor, extraPayMinor } = holidayWorkAmountsMinor(
      salary.components,
      salary.overrideTotalMinor,
      salary.salaryBasis,
      salary.payableDaysBasis,
      Number(row.days_worked),
    )
    const day = calendar.dayFor(row.holiday_date as IsoDate, {
      departmentId: (row.department_id as string | null) ?? null,
      locationId: (row.location_id as string | null) ?? null,
      employeeId: String(row.employee_id),
    })
    const earnedExtraMinor = day.kind === 'HOLIDAY' && day.holidayExtraPay ? extraPayMinor : 0

    return {
      ...row,
      holiday_wage: toMajor(dayWageMinor),
      extra_pay: toMajor(earnedExtraMinor),
      total_amount: toMajor(dayWageMinor + earnedExtraMinor),
    }
  })
}

// ---------------------------------------------------------------------------
// Salary Register
// ---------------------------------------------------------------------------

/** What payroll used for one item, as far as the register's holiday figures need it. */
export interface RegisterHolidayInput {
  /** The days payroll saw for the item (its calculation snapshot). */
  days: DayInput[]
  presentDays: number
  halfDayLeaveDays: number
  /** Holidays rested on and paid - not worked, not forfeited (the item's holiday days). */
  restedHolidays: number
  /** The Holiday Work Pay payroll added for holidays worked. */
  holidayExtraPayMinor: Minor
  /** The structure the item was calculated on; null when it can no longer be found. */
  salary: Omit<PeriodSalary, 'payableDaysBasis'> | null
  payableDaysBasis: number
}

/**
 * The Salary Register's working days and holiday figures for one item:
 *
 *  - Working days: every day worked, a holiday worked included; a half day is
 *    half a day worked.
 *  - Eligible holidays: the holidays that earn holiday pay - each one rested on
 *    and not forfeited by leave on both sides, and each one worked on a holiday
 *    that pays extra for it (half a holiday worked earns half).
 *  - Holiday wages: that holiday pay, without the components left out of
 *    holiday pay (Special Allowance) - the rested holidays at the day rate
 *    proration uses, plus the Holiday Work Pay payroll added.
 *
 * A worked holiday counts both as a working day and as an eligible holiday,
 * because it is paid as both: the day's work with every component, and the
 * holiday without the components left out of holiday pay.
 */
export function registerHolidayFigures(input: RegisterHolidayInput): {
  workingDays: number
  eligibleHolidays: number
  holidayWagesMinor: Minor
} {
  let workedWithExtraPay = 0
  for (const day of input.days) {
    if (!day.isEmployed || day.dayKind !== 'HOLIDAY' || !day.holidayExtraPay) continue
    if (day.status === 'PRESENT') workedWithExtraPay += 1
    else if (day.status === 'HALF_DAY_LEAVE') workedWithExtraPay += 0.5
  }

  const restedPayMinor =
    input.salary && input.restedHolidays > 0
      ? holidayWorkAmountsMinor(
          input.salary.components,
          input.salary.overrideTotalMinor,
          input.salary.salaryBasis,
          input.payableDaysBasis,
          input.restedHolidays,
        ).extraPayMinor
      : 0

  return {
    workingDays: roundDays(input.presentDays + input.halfDayLeaveDays * 0.5),
    eligibleHolidays: roundDays(input.restedHolidays + workedWithExtraPay),
    holidayWagesMinor: restedPayMinor + input.holidayExtraPayMinor,
  }
}

function roundDays(value: number): number {
  return Math.round(value * 100) / 100
}

/** The register's working fields, dropped once its figures are filled in. */
const REGISTER_WORKING_FIELDS = [
  'holiday_extra_pay',
  'present_days',
  'half_day_leave_days',
  'holiday_days',
  'salary_structure_id',
  'payable_days_basis',
  'snapshot_days',
  'override_amount',
]

/** Salary Register: fills in each item's working days and holiday figures (registerHolidayFigures). */
export async function addRegisterHolidayFigures(organizationId: string, rows: ReportRow[]): Promise<ReportRow[]> {
  const structures = new Map<string, { basis: 'MONTHLY' | 'DAILY'; components: ComponentInput[] } | null>()

  const result: ReportRow[] = []
  for (const row of rows) {
    const restedHolidays = Number(row.holiday_days ?? 0)
    let structure: { basis: 'MONTHLY' | 'DAILY'; components: ComponentInput[] } | null = null
    if (restedHolidays > 0 && row.salary_structure_id) {
      const structureId = String(row.salary_structure_id)
      if (!structures.has(structureId)) {
        const found = await salaryRepository.findStructure(structureId, organizationId)
        structures.set(structureId, found ? { basis: found.salary_basis, components: toComponentInputs(found) } : null)
      }
      structure = structures.get(structureId) ?? null
    }

    const figures = registerHolidayFigures({
      days: (row.snapshot_days as DayInput[] | null) ?? [],
      presentDays: Number(row.present_days ?? 0),
      halfDayLeaveDays: Number(row.half_day_leave_days ?? 0),
      restedHolidays,
      holidayExtraPayMinor: toMinor(row.holiday_extra_pay as string),
      salary: structure
        ? {
            components: structure.components,
            overrideTotalMinor:
              row.override_amount === null || row.override_amount === undefined ? null : toMinor(row.override_amount as string),
            salaryBasis: structure.basis,
          }
        : null,
      payableDaysBasis: Number(row.payable_days_basis ?? 0),
    })

    const visible: ReportRow = {
      ...row,
      working_days: figures.workingDays,
      eligible_holidays: figures.eligibleHolidays,
      holiday_wages: toMajor(figures.holidayWagesMinor),
    }
    for (const key of REGISTER_WORKING_FIELDS) delete visible[key]
    result.push(visible)
  }
  return result
}
