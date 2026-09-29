import { describe, expect, it } from 'vitest'
import { calculatePayrollItem, forfeitedHolidayDates, summariseAttendance, type CalculatorInput, type ComponentInput, type DayInput, type PolicyInput } from './payroll.calculator.js'
import { datesInMonth, weekdayOf, type IsoDate } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'

/**
 * Payroll calculation tests (plan section 61).
 *
 * The calculator is pure, so every case here is expressed as data in and numbers
 * out - no database, no clock, no fixtures to reset.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: PolicyInput = {
  paidDaysBasis: 'CALENDAR_DAYS',
  halfDayPaidFraction: 1,
  halfDayUnpaidFraction: 0.5,
  countHolidaysAsPaid: true,
  countWeeklyOffAsPaid: true,
  prorateOnJoining: true,
  prorateOnExit: true,
  netRoundingDecimals: 2,
}

/** September 2026: 30 days, weekly off on Saturday and Sunday. */
function septemberDays(overrides: Partial<Record<IsoDate, Partial<DayInput>>> = {}): DayInput[] {
  return datesInMonth(2026, 9).map((date) => {
    const weekday = weekdayOf(date)
    const isWeekend = weekday === 'SATURDAY' || weekday === 'SUNDAY'
    const base: DayInput = {
      date,
      dayKind: isWeekend ? 'WEEKLY_OFF' : 'WORKING',
      status: isWeekend ? 'WEEKLY_OFF' : 'PRESENT',
      leaveIsPaid: null,
      isEmployed: true,
    }
    return { ...base, ...(overrides[date] ?? {}) }
  })
}

function component(overrides: Partial<ComponentInput> & Pick<ComponentInput, 'code' | 'name'>): ComponentInput {
  return {
    componentType: 'EARNING',
    calculationType: 'FIXED',
    amountMinor: 0,
    percentage: 0,
    percentageBase: null,
    baseComponentCode: null,
    taxable: true,
    prorate: true,
    holidayExtraPay: true,
    displayOrder: 0,
    ...overrides,
  }
}

/** A monthly structure totalling a gross of 42,000. */
function monthlyComponents(): ComponentInput[] {
  return [
    component({ code: 'BASIC', name: 'Basic Salary', amountMinor: toMinor(25_000), displayOrder: 1 }),
    component({ code: 'HRA', name: 'House Rent Allowance', amountMinor: toMinor(10_000), displayOrder: 2 }),
    component({ code: 'SPECIAL', name: 'Special Allowance', amountMinor: toMinor(5_000), displayOrder: 3 }),
    component({ code: 'TRANSPORT', name: 'Transport Allowance', amountMinor: toMinor(2_000), displayOrder: 4 }),
  ]
}

function baseInput(overrides: Partial<CalculatorInput> = {}): CalculatorInput {
  return {
    period: { year: 2026, month: 9, start: '2026-09-01', end: '2026-09-30' },
    employee: { id: 'emp-1', code: 'EMP001', name: 'John Doe', salaryBasis: 'MONTHLY' },
    days: septemberDays(),
    components: monthlyComponents(),
    overrideTotalMinor: null,
    overtime: [],
    bonuses: [],
    tax: null,
    lwf: null,
    plWages: null,
    adjustments: [],
    pf: { applicable: false, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
    esi: { applicable: false, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
    policy: DEFAULT_POLICY,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

describe('summariseAttendance', () => {
  it('counts a fully present month as fully paid', () => {
    const summary = summariseAttendance(septemberDays(), DEFAULT_POLICY)

    expect(summary.calendarDays).toBe(30)
    expect(summary.presentDays).toBe(22)
    expect(summary.weeklyOffDays).toBe(8)
    expect(summary.paidDays).toBe(30)
    expect(summary.payableDaysBasis).toBe(30)
    expect(summary.unmarkedDays).toBe(0)
  })

  it('excludes absent days from paid days', () => {
    const summary = summariseAttendance(
      septemberDays({ '2026-09-03': { status: 'ABSENT' }, '2026-09-04': { status: 'ABSENT' } }),
      DEFAULT_POLICY,
    )

    expect(summary.absentDays).toBe(2)
    expect(summary.paidDays).toBe(28)
  })

  it('pays a paid leave day and does not pay an unpaid one', () => {
    const summary = summariseAttendance(
      septemberDays({
        '2026-09-03': { status: 'ON_LEAVE', leaveIsPaid: true },
        '2026-09-04': { status: 'ON_LEAVE', leaveIsPaid: false },
      }),
      DEFAULT_POLICY,
    )

    expect(summary.paidLeaveDays).toBe(1)
    expect(summary.unpaidLeaveDays).toBe(1)
    expect(summary.leaveDays).toBe(2)
    expect(summary.paidDays).toBe(29)
  })

  it('treats a half day as a half day, never a full one', () => {
    const paid = summariseAttendance(
      septemberDays({ '2026-09-03': { status: 'HALF_DAY_LEAVE', leaveIsPaid: true } }),
      DEFAULT_POLICY,
    )
    const unpaid = summariseAttendance(
      septemberDays({ '2026-09-03': { status: 'HALF_DAY_LEAVE', leaveIsPaid: false } }),
      DEFAULT_POLICY,
    )

    expect(paid.halfDayLeaveDays).toBe(1)
    // Paid half-day leave: worked half + paid half = a full paid day.
    expect(paid.paidDays).toBe(30)
    // Unpaid half-day leave: only the worked half is paid.
    expect(unpaid.paidDays).toBe(29.5)
  })

  it('honours a policy that does not pay weekly offs', () => {
    const summary = summariseAttendance(septemberDays(), {
      ...DEFAULT_POLICY,
      countWeeklyOffAsPaid: false,
    })

    expect(summary.weeklyOffDays).toBe(8)
    expect(summary.paidDays).toBe(22)
  })

  it('counts a holiday as a paid day', () => {
    const summary = summariseAttendance(
      septemberDays({ '2026-09-02': { dayKind: 'HOLIDAY', status: 'HOLIDAY' } }),
      DEFAULT_POLICY,
    )

    expect(summary.holidayDays).toBe(1)
    expect(summary.paidDays).toBe(30)
  })

  it('does not pay a holiday flagged as forfeited, and counts it as absent', () => {
    const summary = summariseAttendance(
      septemberDays({
        '2026-09-02': { dayKind: 'HOLIDAY', status: 'HOLIDAY', holidayForfeited: true },
        '2026-09-01': { status: 'ABSENT' },
        '2026-09-03': { status: 'ABSENT' },
      }),
      DEFAULT_POLICY,
    )

    expect(summary.holidayDays).toBe(0)
    expect(summary.absentDays).toBe(3)
    expect(summary.paidDays).toBe(27)
  })

  it('treats an unmarked working day as unpaid and reports it', () => {
    const summary = summariseAttendance(septemberDays({ '2026-09-03': { status: null } }), DEFAULT_POLICY)

    expect(summary.unmarkedDays).toBe(1)
    expect(summary.paidDays).toBe(29)
  })

  it('restricts both numerator and denominator under the WORKING_DAYS basis', () => {
    const summary = summariseAttendance(septemberDays({ '2026-09-03': { status: 'ABSENT' } }), {
      ...DEFAULT_POLICY,
      paidDaysBasis: 'WORKING_DAYS',
    })

    expect(summary.workingDays).toBe(22)
    expect(summary.payableDaysBasis).toBe(22)
    expect(summary.paidDays).toBe(21)
  })
})

describe('forfeitedHolidayDates', () => {
  // 2026-09-02 (Wed) is the holiday; 09-01 and 09-03 are the days either side.
  const HOLIDAY = '2026-09-02'
  const holiday = { dayKind: 'HOLIDAY', status: 'HOLIDAY' } as const
  const forfeited = (overrides: Partial<Record<IsoDate, Partial<DayInput>>>) =>
    [...forfeitedHolidayDates(septemberDays(overrides))]

  it('forfeits a holiday with an absence on both sides', () => {
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': { status: 'ABSENT' }, '2026-09-03': { status: 'ABSENT' } })).toEqual([
      HOLIDAY,
    ])
  })

  it('also forfeits a holiday nobody marked', () => {
    expect(
      forfeited({ [HOLIDAY]: { dayKind: 'HOLIDAY', status: null }, '2026-09-01': { status: 'ABSENT' }, '2026-09-03': { status: 'ABSENT' } }),
    ).toEqual([HOLIDAY])
  })

  it('counts unpaid leave as an absence, but not paid leave', () => {
    const unpaid = { status: 'ON_LEAVE', leaveIsPaid: false } as const
    const paid = { status: 'ON_LEAVE', leaveIsPaid: true } as const
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': unpaid, '2026-09-03': { status: 'ABSENT' } })).toEqual([HOLIDAY])
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': paid, '2026-09-03': { status: 'ABSENT' } })).toEqual([])
  })

  it('keeps the holiday paid when only one side is absent', () => {
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': { status: 'ABSENT' } })).toEqual([])
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-03': { status: 'ABSENT' } })).toEqual([])
  })

  it('never forfeits a holiday that was worked', () => {
    expect(
      forfeited({
        [HOLIDAY]: { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true },
        '2026-09-01': { status: 'ABSENT' },
        '2026-09-03': { status: 'ABSENT' },
      }),
    ).toEqual([])
  })

  it('judges a run of holidays by the days either side of the whole run', () => {
    expect(
      forfeited({
        '2026-09-02': holiday,
        '2026-09-03': holiday,
        '2026-09-01': { status: 'ABSENT' },
        '2026-09-04': { status: 'ABSENT' },
      }),
    ).toEqual(['2026-09-02', '2026-09-03'])
  })

  it('does not forfeit when a weekly off sits between the absence and the holiday', () => {
    // 09-07 (Mon) holiday; 09-05/06 are the weekend, 09-04 (Fri) and 09-08 absent.
    expect(
      forfeited({ '2026-09-07': holiday, '2026-09-04': { status: 'ABSENT' }, '2026-09-08': { status: 'ABSENT' } }),
    ).toEqual([])
  })

  it('does not forfeit a holiday at the edge of the days it was given', () => {
    expect(forfeited({ '2026-09-01': holiday, '2026-09-02': { status: 'ABSENT' } })).toEqual([])
  })

  it('counts a half day either side as skipped: a half day before and leave after forfeits the holiday', () => {
    const halfDay = { status: 'HALF_DAY_LEAVE', leaveIsPaid: false } as const
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': halfDay, '2026-09-03': { status: 'ABSENT' } })).toEqual([HOLIDAY])
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': { status: 'ABSENT' }, '2026-09-03': halfDay })).toEqual([HOLIDAY])
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': halfDay, '2026-09-03': halfDay })).toEqual([HOLIDAY])
  })

  it('keeps the holiday paid when a half day sits on one side and a full day worked on the other', () => {
    const halfDay = { status: 'HALF_DAY_LEAVE', leaveIsPaid: false } as const
    expect(forfeited({ [HOLIDAY]: holiday, '2026-09-01': halfDay })).toEqual([])
  })

  it('never forfeits a holiday worked for half a day', () => {
    expect(
      forfeited({
        [HOLIDAY]: { dayKind: 'HOLIDAY', status: 'HALF_DAY_LEAVE', leaveIsPaid: false },
        '2026-09-01': { status: 'ABSENT' },
        '2026-09-03': { status: 'ABSENT' },
      }),
    ).toEqual([])
  })
})

describe('calculatePayrollItem - forfeited holiday', () => {
  it('pays neither the absences nor the holiday between them', () => {
    const paid = calculatePayrollItem(baseInput({ days: septemberDays({ '2026-09-02': { dayKind: 'HOLIDAY', status: 'HOLIDAY' } }) }))
    const skipped = calculatePayrollItem(
      baseInput({
        days: septemberDays({
          '2026-09-01': { status: 'ABSENT' },
          '2026-09-02': { dayKind: 'HOLIDAY', status: 'HOLIDAY', holidayForfeited: true },
          '2026-09-03': { status: 'ABSENT' },
        }),
      }),
    )

    expect(paid.attendance.paidDays).toBe(30)
    expect(skipped.attendance.paidDays).toBe(27)
    // 42,000 over 30 days: three unpaid days cost 4,200.
    expect(toMajor(paid.grossEarningsMinor - skipped.grossEarningsMinor)).toBe(4200)
  })

  it('with a half day before and an absence after, pays only the worked half of the three days', () => {
    const contextDays = septemberDays({
      '2026-09-01': { status: 'HALF_DAY_LEAVE', leaveIsPaid: false },
      '2026-09-02': { dayKind: 'HOLIDAY', status: 'HOLIDAY' },
      '2026-09-03': { status: 'ABSENT' },
    })
    const forfeited = forfeitedHolidayDates(contextDays)
    const result = calculatePayrollItem(
      baseInput({ days: contextDays.map((day) => (forfeited.has(day.date) ? { ...day, holidayForfeited: true } : day)) }),
    )

    expect(result.attendance.paidDays).toBe(27.5)
    expect(result.attendance.absentDays).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Monthly salary
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - monthly employee', () => {
  it('pays the full gross for a fully present month', () => {
    const result = calculatePayrollItem(baseInput())

    expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
    expect(toMajor(result.totalDeductionsMinor)).toBe(0)
    expect(toMajor(result.netSalaryMinor)).toBe(42_000)
  })

  it('prorates the gross by paid days when the employee is absent', () => {
    const result = calculatePayrollItem(
      baseInput({
        days: septemberDays({ '2026-09-03': { status: 'ABSENT' }, '2026-09-04': { status: 'ABSENT' } }),
      }),
    )

    // 28 paid days out of 30: 42,000 x 28/30 = 39,200.
    expect(result.attendance.paidDays).toBe(28)
    expect(toMajor(result.grossEarningsMinor)).toBe(39_200)
  })

  it('does not prorate a component marked as non-proratable', () => {
    const components = monthlyComponents().map((entry) =>
      entry.code === 'TRANSPORT' ? { ...entry, prorate: false } : entry,
    )
    const result = calculatePayrollItem(
      baseInput({ components, days: septemberDays({ '2026-09-03': { status: 'ABSENT' } }) }),
    )

    const transport = result.components.find((entry) => entry.code === 'TRANSPORT')
    expect(toMajor(transport?.amountMinor ?? 0)).toBe(2_000)
  })

  it('resolves a percentage component against its base', () => {
    const components: ComponentInput[] = [
      component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(30_000), displayOrder: 1 }),
      component({
        code: 'HRA',
        name: 'HRA',
        calculationType: 'PERCENTAGE',
        percentage: 40,
        percentageBase: 'BASIC',
        displayOrder: 2,
      }),
    ]

    const result = calculatePayrollItem(baseInput({ components }))
    const hra = result.components.find((entry) => entry.code === 'HRA')

    expect(toMajor(hra?.amountMinor ?? 0)).toBe(12_000)
    expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
  })

  it('scales the whole structure to an employee override amount', () => {
    const result = calculatePayrollItem(baseInput({ overrideTotalMinor: toMinor(21_000) }))

    // The structure totals 42,000, so every earning halves and the total is exact.
    expect(toMajor(result.grossEarningsMinor)).toBe(21_000)
    const basic = result.components.find((entry) => entry.code === 'BASIC')
    expect(toMajor(basic?.amountMinor ?? 0)).toBe(12_500)
  })
})

// ---------------------------------------------------------------------------
// Daily salary
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - daily employee', () => {
  it('multiplies the daily rate by paid days', () => {
    // 800 per day. September 2026 has 22 working days; four are overridden below,
    // leaving 18 present. Weekly offs are unpaid under this policy.
    const days = septemberDays({
      '2026-09-03': { status: 'HALF_DAY_LEAVE', leaveIsPaid: false },
      '2026-09-07': { status: 'ON_LEAVE', leaveIsPaid: true },
      '2026-09-08': { status: 'ON_LEAVE', leaveIsPaid: true },
      '2026-09-09': { status: 'ON_LEAVE', leaveIsPaid: false },
    })

    const result = calculatePayrollItem(
      baseInput({
        employee: { id: 'emp-2', code: 'EMP002', name: 'Daily Worker', salaryBasis: 'DAILY' },
        components: [component({ code: 'DAILY_RATE', name: 'Daily Wage', amountMinor: toMinor(800) })],
        days,
        policy: { ...DEFAULT_POLICY, countWeeklyOffAsPaid: false },
      }),
    )

    // 18 present + 0.5 (worked half) + 2 paid leave = 20.5 paid days.
    expect(result.attendance.paidDays).toBe(20.5)
    expect(toMajor(result.grossEarningsMinor)).toBe(16_400)
  })
})

// ---------------------------------------------------------------------------
// Statutory contributions
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - PF and ESI', () => {
  it('caps the PF wage at the structure ceiling and splits the employer share into EPS and EPF', () => {
    const result = calculatePayrollItem(
      baseInput({
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      }),
    )

    // The structure's gross is 42,000, capped at the 15,000 ceiling: 12% = 1,800, both sides.
    const pfEmployee = result.components.find((entry) => entry.code === 'PF_EMPLOYEE')
    const pfEmployerEps = result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPS')
    const pfEmployerEpf = result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPF')

    expect(toMajor(pfEmployee?.amountMinor ?? 0)).toBe(1_800)
    // EPS is 8.33% of 15,000 = 1,249.50, rounded to the nearest rupee = 1,250.
    expect(toMajor(pfEmployerEps?.amountMinor ?? 0)).toBe(1_250)
    // EPF is whatever is left of the 1,800 employer total: 550.
    expect(toMajor(pfEmployerEpf?.amountMinor ?? 0)).toBe(550)
    expect(toMajor(result.totalDeductionsMinor)).toBe(1_800)
    // The employer share never reduces net pay.
    expect(toMajor(result.netSalaryMinor)).toBe(40_200)
    expect(toMajor(result.employerContributionsMinor)).toBe(1_800)
    expect(toMajor(result.pfWageMinor)).toBe(15_000)
  })

  it('matches the worked example: 26,400 gross, 15,000 ceiling, 1,800 both sides split 1,250 + 550', () => {
    const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(26_400) })]

    const result = calculatePayrollItem(
      baseInput({
        components,
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      }),
    )

    expect(toMajor(result.pfWageMinor)).toBe(15_000)
    expect(toMajor(result.components.find((entry) => entry.code === 'PF_EMPLOYEE')?.amountMinor ?? 0)).toBe(1_800)
    expect(toMajor(result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPS')?.amountMinor ?? 0)).toBe(1_250)
    expect(toMajor(result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPF')?.amountMinor ?? 0)).toBe(550)
  })

  it('puts the whole employer share into EPF for a member outside the Pension Scheme (EPS rate 0)', () => {
    // payroll.service passes an EPS rate of 0 when the employee's "Pension applicable" is No.
    const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(26_400) })]
    const result = calculatePayrollItem(
      baseInput({
        components,
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 0 },
      }),
    )

    expect(toMajor(result.components.find((entry) => entry.code === 'PF_EMPLOYEE')?.amountMinor ?? 0)).toBe(1_800)
    expect(result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPS')).toBeUndefined()
    const epf = result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPF')
    expect(toMajor(epf?.amountMinor ?? 0)).toBe(1_800)
    expect(epf?.percentage).toBe(12)
    expect(toMajor(result.employerContributionsMinor)).toBe(1_800)
  })

  it('rounds every PF contribution to the nearest whole rupee, never paise', () => {
    const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(10_000) })]

    const result = calculatePayrollItem(
      baseInput({
        components,
        // A deliberately awkward rate: 10,000 x 12.126% = 1,212.60, which must
        // round up to 1,213 rather than land on a fraction of a rupee.
        pf: { applicable: true, employeeRate: 12.126, employerRate: 12.126, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      }),
    )

    const pfEmployee = result.components.find((entry) => entry.code === 'PF_EMPLOYEE')
    const pfEmployerEps = result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPS')
    const pfEmployerEpf = result.components.find((entry) => entry.code === 'PF_EMPLOYER_EPF')

    expect(toMajor(pfEmployee?.amountMinor ?? 0)).toBe(1_213)
    expect(toMajor(pfEmployerEps?.amountMinor ?? 0)).toBe(833)
    expect(toMajor(pfEmployerEpf?.amountMinor ?? 0)).toBe(380)
    // EPS and EPF must add back to the employer total exactly - no drift.
    expect((pfEmployerEps?.amountMinor ?? 0) + (pfEmployerEpf?.amountMinor ?? 0)).toBe(
      result.employerContributionsMinor,
    )
    expect(toMajor(result.employerContributionsMinor)).toBe(1_213)
  })

  it('does not cap the PF wage when the ceiling is zero', () => {
    const result = calculatePayrollItem(
      baseInput({
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: 0, epsRate: 0 },
      }),
    )

    // No ceiling: 12% of the full 42,000 structure gross.
    expect(toMajor(result.pfWageMinor)).toBe(42_000)
    expect(toMajor(result.components.find((entry) => entry.code === 'PF_EMPLOYEE')?.amountMinor ?? 0)).toBe(5_040)
  })

  it('uses the structure rate, not a flat default', () => {
    const result = calculatePayrollItem(
      baseInput({
        pf: { applicable: true, employeeRate: 10, employerRate: 10, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      }),
    )

    // 10% of the 15,000 ceiling.
    const pfEmployee = result.components.find((entry) => entry.code === 'PF_EMPLOYEE')
    expect(toMajor(pfEmployee?.amountMinor ?? 0)).toBe(1_500)
  })

  it('skips ESI when the wage is above the ₹21,000 eligibility limit', () => {
    const result = calculatePayrollItem(
      baseInput({
        esi: { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
      }),
    )

    // The structure's gross is 42,000, above the 21,000 limit, so the scheme does not apply.
    expect(result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')).toBeUndefined()
    expect(toMajor(result.totalDeductionsMinor)).toBe(0)
  })

  it('applies ESI on both sides, on the full wage, when the wage is within the limit', () => {
    const components = [
      component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(12_000) }),
      component({ code: 'HRA', name: 'HRA', amountMinor: toMinor(4_000), displayOrder: 2 }),
    ]

    const result = calculatePayrollItem(
      baseInput({
        components,
        esi: { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
      }),
    )

    // ESI wage 16,000 - the full structure gross, not capped: employee 0.75% = 120, employer 3.25% = 520.
    const esiEmployee = result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')
    const esiEmployer = result.components.find((entry) => entry.code === 'ESI_EMPLOYER')
    expect(toMajor(esiEmployee?.amountMinor ?? 0)).toBe(120)
    expect(toMajor(esiEmployer?.amountMinor ?? 0)).toBe(520)
    expect(toMajor(result.esiWageMinor)).toBe(16_000)
  })

  it('applies ESI exactly at the ₹21,000 boundary', () => {
    const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(21_000) })]

    const result = calculatePayrollItem(
      baseInput({
        components,
        esi: { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
      }),
    )

    expect(result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')).toBeDefined()
  })

  describe('ESI eligibility on a standard month', () => {
    const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
    const dailyWorker = { id: 'emp-2', code: 'EMP002', name: 'Daily Worker', salaryBasis: 'DAILY' } as const
    const dailyRate = (rate: number) => [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(rate) })]
    /** September with its first `count` working days marked absent: 30 - count paid days. */
    const withAbsences = (count: number) => {
      const absent = septemberDays().filter((day) => day.dayKind === 'WORKING').slice(0, count)
      return septemberDays(Object.fromEntries(absent.map((day) => [day.date, { status: 'ABSENT' as const }])))
    }
    const line = (result: ReturnType<typeof calculatePayrollItem>, code: string) =>
      result.components.find((entry) => entry.code === code)

    it('deducts ESI from a daily worker whose 26 days are within the limit', () => {
      const result = calculatePayrollItem(
        baseInput({ employee: dailyWorker, components: dailyRate(769), esi, days: withAbsences(4) }),
      )

      // 26 x 769 = 19,994: 149.955 / 649.805 up to 150 / 650.
      expect(result.attendance.paidDays).toBe(26)
      expect(toMajor(result.esiWageMinor)).toBe(19_994)
      expect(toMajor(line(result, 'ESI_EMPLOYEE')?.amountMinor ?? 0)).toBe(150)
      expect(toMajor(line(result, 'ESI_EMPLOYER')?.amountMinor ?? 0)).toBe(650)
    })

    it('keeps deducting ESI when extra days take the month over the limit, on the limit alone', () => {
      const result = calculatePayrollItem(
        baseInput({ employee: dailyWorker, components: dailyRate(769), esi, days: withAbsences(2) }),
      )

      // 28 days earn 21,532, over 21,000, but 26 days (19,994) are within it:
      // ESI is charged on 21,000 - 157.50 / 682.50 up to 158 / 683.
      expect(result.attendance.paidDays).toBe(28)
      expect(toMajor(result.grossEarningsMinor)).toBe(21_532)
      expect(toMajor(result.esiWageMinor)).toBe(21_000)
      expect(toMajor(line(result, 'ESI_EMPLOYEE')?.amountMinor ?? 0)).toBe(158)
      expect(toMajor(line(result, 'ESI_EMPLOYER')?.amountMinor ?? 0)).toBe(683)
      expect(line(result, 'ESI_EMPLOYEE')?.notes).toBe('ESI wage 21000')
    })

    it('leaves ESI off a daily worker whose 26 days are over the limit, even in a short month', () => {
      const result = calculatePayrollItem(
        baseInput({ employee: dailyWorker, components: dailyRate(850), esi, days: withAbsences(10) }),
      )

      // 20 days earn only 17,000, but 26 x 850 = 22,100 is over 21,000.
      expect(toMajor(result.grossEarningsMinor)).toBe(17_000)
      expect(line(result, 'ESI_EMPLOYEE')).toBeUndefined()
      expect(result.esiWageMinor).toBe(0)
    })

    it('leaves ESI off a monthly structure over the limit, even in a short month', () => {
      const result = calculatePayrollItem(baseInput({ esi, days: withAbsences(16) }))

      // 14 of 30 days of the 42,000 gross earn 19,600, but the monthly gross is over 21,000.
      expect(toMajor(result.grossEarningsMinor)).toBe(19_600)
      expect(line(result, 'ESI_EMPLOYEE')).toBeUndefined()
    })
  })

  describe('rounding', () => {
    const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
    const esiFor = (basic: number) => {
      const result = calculatePayrollItem(
        baseInput({ components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(basic) })], esi }),
      )
      const amount = (code: string) => toMajor(result.components.find((entry) => entry.code === code)?.amountMinor ?? 0)
      return { employee: amount('ESI_EMPLOYEE'), employer: amount('ESI_EMPLOYER'), result }
    }

    it('rounds ESI up to the next whole rupee on both sides, even for a single paisa', () => {
      // 13,468 x 0.75% = 101.01 and x 3.25% = 437.71: one paisa over a rupee still moves up.
      expect(esiFor(13_468)).toMatchObject({ employee: 102, employer: 438 })
      // 16,650 x 0.75% = 124.875 and x 3.25% = 541.125.
      expect(esiFor(16_650)).toMatchObject({ employee: 125, employer: 542 })
    })

    it('leaves an ESI amount that is already a whole rupee alone', () => {
      expect(esiFor(16_000)).toMatchObject({ employee: 120, employer: 520 })
    })

    it('rounds PF to the nearest rupee: .4 goes down, .6 goes up, and EPS + EPF add back to the employer share', () => {
      const pfFor = (basic: number) => {
        const result = calculatePayrollItem(
          baseInput({
            components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(basic) })],
            pf: { applicable: true, employeeRate: 10, employerRate: 10, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
          }),
        )
        const amount = (code: string) => result.components.find((entry) => entry.code === code)?.amountMinor ?? 0
        return {
          employee: toMajor(amount('PF_EMPLOYEE')),
          eps: toMajor(amount('PF_EMPLOYER_EPS')),
          epf: toMajor(amount('PF_EMPLOYER_EPF')),
          employerTotal: toMajor(result.employerContributionsMinor),
        }
      }

      // 12,344 x 10% = 1,234.40 -> 1,234; 12,346 x 10% = 1,234.60 -> 1,235.
      const down = pfFor(12_344)
      const up = pfFor(12_346)
      expect(down.employee).toBe(1_234)
      expect(up.employee).toBe(1_235)
      expect(down.eps + down.epf).toBe(down.employerTotal)
      expect(up.eps + up.epf).toBe(up.employerTotal)
      expect(up.employerTotal).toBe(1_235)
    })

    it('keeps the net salary in paise: only PF and ESI are rounded, not the prorated earnings', () => {
      // One absent day in a 30-day month: 16,000 x 29/30 = 15,466.67 gross; ESI 0.75% of that is 116.
      const result = calculatePayrollItem(
        baseInput({
          components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(16_000) })],
          days: septemberDays({ '2026-09-03': { status: 'ABSENT' } }),
          esi,
        }),
      )
      expect(toMajor(result.grossEarningsMinor)).toBe(15_466.67)
      expect(toMajor(result.totalDeductionsMinor)).toBe(116)
      expect(toMajor(result.netSalaryMinor)).toBe(15_350.67)
    })
  })

  describe('holiday work pay', () => {
    // Monday 7 Sept 2026 is a company holiday that pays extra to whoever works it.
    const HOLIDAY = '2026-09-07'
    const holidayDay = (status: DayInput['status'], extra = true): Partial<Record<IsoDate, Partial<DayInput>>> => ({
      [HOLIDAY]: { dayKind: 'HOLIDAY', status, holidayExtraPay: extra },
    })
    const earning = (result: ReturnType<typeof calculatePayrollItem>, code: string) =>
      result.components.find((entry) => entry.code === code)

    it('pays one extra day, on top of the paid holiday, to an employee who worked it', () => {
      const result = calculatePayrollItem(baseInput({ days: septemberDays(holidayDay('PRESENT')) }))

      // A full month is 42,000 for 30 days = 1,400 a day. The holiday is already inside the 42,000.
      expect(toMajor(earning(result, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(1_400)
      expect(earning(result, 'HOLIDAY_WORK')).toMatchObject({ source: 'HOLIDAY_WORK', componentType: 'EARNING' })
      expect(toMajor(result.grossEarningsMinor)).toBe(43_400)
      expect(toMajor(result.netSalaryMinor)).toBe(43_400)
    })

    it('names each worked holiday and its date on the pay line', () => {
      const result = calculatePayrollItem(
        baseInput({
          days: septemberDays({
            [HOLIDAY]: { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true, holidayName: 'Labour Day' },
            '2026-09-14': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true },
          }),
        }),
      )
      expect(earning(result, 'HOLIDAY_WORK')?.notes).toBe('Worked Labour Day (7 Sep 2026), 14 Sep 2026')
    })

    it('adds nothing for an employee who took the holiday off', () => {
      const result = calculatePayrollItem(baseInput({ days: septemberDays(holidayDay('HOLIDAY')) }))
      expect(earning(result, 'HOLIDAY_WORK')).toBeUndefined()
      expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
    })

    it('adds nothing when the holiday does not have the option on', () => {
      const result = calculatePayrollItem(baseInput({ days: septemberDays(holidayDay('PRESENT', false)) }))
      expect(earning(result, 'HOLIDAY_WORK')).toBeUndefined()
      expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
    })

    it('adds nothing for a normal working day', () => {
      const result = calculatePayrollItem(baseInput())
      expect(earning(result, 'HOLIDAY_WORK')).toBeUndefined()
    })

    it('pays each worked holiday once, and nothing for a holiday before the employee joined', () => {
      const worked = {
        ...holidayDay('PRESENT'),
        '2026-09-14': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true },
      } as const
      const two = calculatePayrollItem(baseInput({ days: septemberDays(worked) }))
      const one = calculatePayrollItem(baseInput({ days: septemberDays(holidayDay('PRESENT')) }))
      expect(toMajor(earning(two, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(2_800)
      expect(toMajor(earning(one, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(1_400)

      // A third flagged holiday on a day the employee was not yet employed adds no day.
      const notEmployed = { '2026-09-21': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true, isEmployed: false } } as const
      const withUnemployed = calculatePayrollItem(baseInput({ days: septemberDays({ ...worked, ...notEmployed }) }))
      const withoutFlag = calculatePayrollItem(
        baseInput({ days: septemberDays({ ...worked, '2026-09-21': { isEmployed: false } }) }),
      )
      expect(earning(withUnemployed, 'HOLIDAY_WORK')?.amountMinor).toBe(earning(withoutFlag, 'HOLIDAY_WORK')?.amountMinor)
    })

    it('pays a holiday worked for half a day as a half day, plus half a day extra when the option is on', () => {
      const half = { status: 'HALF_DAY_LEAVE', leaveIsPaid: false } as const
      const withExtra = calculatePayrollItem(
        baseInput({ days: septemberDays({ [HOLIDAY]: { dayKind: 'HOLIDAY', holidayExtraPay: true, ...half } }) }),
      )
      const withoutExtra = calculatePayrollItem(
        baseInput({ days: septemberDays({ [HOLIDAY]: { dayKind: 'HOLIDAY', holidayExtraPay: false, ...half } }) }),
      )

      // 1,400 a day: the worked half is 700 through the paid days...
      expect(withoutExtra.attendance.paidDays).toBe(29.5)
      expect(toMajor(withoutExtra.grossEarningsMinor)).toBe(41_300)
      expect(earning(withoutExtra, 'HOLIDAY_WORK')).toBeUndefined()
      // ...and the extra pay is another 700, two half days in all.
      expect(withExtra.attendance.paidDays).toBe(29.5)
      expect(toMajor(earning(withExtra, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(700)
      expect(toMajor(withExtra.grossEarningsMinor)).toBe(42_000)
      expect(earning(withExtra, 'HOLIDAY_WORK')?.notes).toBe('Worked 7 Sep 2026 - half day')
    })

    it('pays a half-worked holiday as a half day even under a paid leave type', () => {
      const result = calculatePayrollItem(
        baseInput({
          days: septemberDays({
            [HOLIDAY]: { dayKind: 'HOLIDAY', status: 'HALF_DAY_LEAVE', leaveIsPaid: true, holidayExtraPay: false },
          }),
        }),
      )
      expect(result.attendance.paidDays).toBe(29.5)
    })

    it('pays a daily-rate employee one more day at the daily rate', () => {
      const result = calculatePayrollItem(
        baseInput({
          employee: { id: 'emp-2', code: 'EMP002', name: 'Daily Worker', salaryBasis: 'DAILY' },
          components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(800) })],
          days: septemberDays(holidayDay('PRESENT')),
        }),
      )
      expect(toMajor(earning(result, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(800)
    })

    it('leaves a component switched out of holiday extra pay out of the extra day, but pays it for the paid days', () => {
      // SKT's daily structure: Basic 494 + DA 287 + Special Allowance 138 = 919 a day.
      const components = [
        component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(494), displayOrder: 1 }),
        component({ code: 'DA', name: 'Dearness Allowance', amountMinor: toMinor(287), displayOrder: 2 }),
        component({ code: 'SA', name: 'Special Allowance', amountMinor: toMinor(138), displayOrder: 3, holidayExtraPay: false }),
      ]
      const employee = { id: 'emp-2', code: 'EMP002', name: 'Daily Worker', salaryBasis: 'DAILY' } as const
      const full = calculatePayrollItem(baseInput({ employee, components, days: septemberDays(holidayDay('PRESENT')) }))
      const half = calculatePayrollItem(
        baseInput({ employee, components, days: septemberDays(holidayDay('HALF_DAY_LEAVE')) }),
      )

      // The extra day is Basic + DA only: 781, and half of that for a half day.
      expect(toMajor(earning(full, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(781)
      expect(toMajor(earning(half, 'HOLIDAY_WORK')?.amountMinor ?? 0)).toBe(390.5)
      // The Special Allowance itself is still paid for all 30 paid days.
      expect(toMajor(earning(full, 'SA')?.amountMinor ?? 0)).toBe(4_140)
      expect(toMajor(full.grossEarningsMinor)).toBe(919 * 30 + 781)
    })

    it('pays no holiday work at all when every component is switched out of it', () => {
      const components = [component({ code: 'SA', name: 'Special Allowance', amountMinor: toMinor(42_000), holidayExtraPay: false })]
      const result = calculatePayrollItem(baseInput({ components, days: septemberDays(holidayDay('PRESENT')) }))
      expect(earning(result, 'HOLIDAY_WORK')).toBeUndefined()
      expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
    })

    it('counts towards the PF wage', () => {
      const pf = { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: 0, epsRate: 0 }
      const without = calculatePayrollItem(baseInput({ pf }))
      const worked = calculatePayrollItem(baseInput({ days: septemberDays(holidayDay('PRESENT')), pf }))

      // 42,000 -> 43,400 with the extra day; 12% of that is 5,208.
      expect(toMajor(without.pfWageMinor)).toBe(42_000)
      expect(toMajor(worked.pfWageMinor)).toBe(43_400)
      expect(toMajor(earning(worked, 'PF_EMPLOYEE')?.amountMinor ?? 0)).toBe(5_208)
    })

    it('still respects the PF wage ceiling', () => {
      const result = calculatePayrollItem(
        baseInput({
          days: septemberDays(holidayDay('PRESENT')),
          pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
        }),
      )
      expect(toMajor(result.pfWageMinor)).toBe(15_000)
      expect(toMajor(earning(result, 'PF_EMPLOYEE')?.amountMinor ?? 0)).toBe(1_800)
    })

    it('counts towards the ESI wage, on both sides, rounded up', () => {
      const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
      const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(15_000) })]
      const without = calculatePayrollItem(baseInput({ components, esi }))
      const worked = calculatePayrollItem(baseInput({ components, esi, days: septemberDays(holidayDay('PRESENT')) }))

      // 15,000 -> 112.50 / 487.50 up to 113 / 488.
      expect(toMajor(earning(without, 'ESI_EMPLOYEE')?.amountMinor ?? 0)).toBe(113)
      expect(toMajor(earning(without, 'ESI_EMPLOYER')?.amountMinor ?? 0)).toBe(488)
      // One extra day is 500, so the wage is 15,500: 116.25 / 503.75 up to 117 / 504.
      expect(toMajor(worked.esiWageMinor)).toBe(15_500)
      expect(toMajor(earning(worked, 'ESI_EMPLOYEE')?.amountMinor ?? 0)).toBe(117)
      expect(toMajor(earning(worked, 'ESI_EMPLOYER')?.amountMinor ?? 0)).toBe(504)
    })

    it('does not drop an ESI-eligible employee out of ESI because the extra day takes the wage over the limit', () => {
      const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
      const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(20_800) })]
      const result = calculatePayrollItem(baseInput({ components, esi, days: septemberDays(holidayDay('PRESENT')) }))

      // 20,800 + 693.33 = 21,493.33 is over 21,000, but the structure (20,800) is
      // not: ESI stays, charged on the 21,000 limit alone.
      expect(toMajor(result.esiWageMinor)).toBe(21_000)
      // 0.75% of 21,000 = 157.50, rounded up.
      expect(toMajor(earning(result, 'ESI_EMPLOYEE')?.amountMinor ?? 0)).toBe(158)
    })

    it('leaves ESI off when the structure itself is over the limit', () => {
      const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
      const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(22_000) })]
      const result = calculatePayrollItem(baseInput({ components, esi, days: septemberDays(holidayDay('PRESENT')) }))
      expect(earning(result, 'ESI_EMPLOYEE')).toBeUndefined()
    })
  })

  it('does not deduct PF or ESI when the employee is not enrolled', () => {
    const result = calculatePayrollItem(baseInput())

    expect(result.components.find((entry) => entry.code === 'PF_EMPLOYEE')).toBeUndefined()
    expect(result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')).toBeUndefined()
    expect(result.pfWageMinor).toBe(0)
    expect(result.esiWageMinor).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Bonuses and the worked example from the plan
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - bonuses', () => {
  it('adds a bonus as an earning', () => {
    const result = calculatePayrollItem(
      baseInput({
        bonuses: [
          {
            id: 'bonus-1',
            code: 'FESTIVAL',
            name: 'Festival Bonus',
            amountType: 'FIXED_AMOUNT',
            amountMinor: toMinor(2_000),
            percentage: 0,
            taxable: true,
          },
        ],
      }),
    )

    expect(toMajor(result.totalBonusMinor)).toBe(2_000)
    expect(toMajor(result.grossEarningsMinor)).toBe(44_000)
  })

  it('combines a bonus and PF, with ESI excluded above the limit', () => {
    const result = calculatePayrollItem(
      baseInput({
        components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(40_000) })],
        bonuses: [
          {
            id: 'bonus-1',
            code: 'PERFORMANCE',
            name: 'Performance Bonus',
            amountType: 'FIXED_AMOUNT',
            amountMinor: toMinor(2_000),
            percentage: 0,
            taxable: true,
          },
        ],
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
        // The structure's gross (40,000) is above ₹21,000, so ESI does not apply at all.
        esi: { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
      }),
    )

    expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
    expect(result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')).toBeUndefined()
    // PF 1,800 (12% of the 15,000 ceiling).
    expect(toMajor(result.totalDeductionsMinor)).toBe(1_800)
    expect(toMajor(result.netSalaryMinor)).toBe(40_200)
  })

  it('deducts the tax set for the month as its own line, counted in total deductions', () => {
    const result = calculatePayrollItem(
      baseInput({ tax: { id: 'tax-1', amountMinor: toMinor(1_180), note: 'On wages 88061 for 2025-10-01 to 2026-03-31' } }),
    )

    const line = result.components.find((entry) => entry.code === 'PTAX')
    expect(line).toMatchObject({ name: 'P.Tax', componentType: 'DEDUCTION', referenceId: 'tax-1' })
    expect(toMajor(line?.amountMinor ?? 0)).toBe(1_180)
    expect(toMajor(result.totalDeductionsMinor)).toBe(1_180)
    expect(toMajor(result.netSalaryMinor)).toBe(toMajor(result.grossEarningsMinor) - 1_180)
  })

  it('deducts nothing when no tax is set for the month', () => {
    const result = calculatePayrollItem(baseInput())
    expect(result.components.find((entry) => entry.code === 'PTAX')).toBeUndefined()
  })

  it('deducts the Labour Welfare Fund contribution set for the month as its own line', () => {
    const result = calculatePayrollItem(
      baseInput({ lwf: { id: 'lwf-1', amountMinor: toMinor(20), note: 'Labour Welfare Fund for 2026' } }),
    )

    const line = result.components.find((entry) => entry.code === 'LWF_EMPLOYEE')
    expect(line).toMatchObject({ name: 'Labour Welfare Fund', componentType: 'DEDUCTION', referenceId: 'lwf-1' })
    expect(toMajor(line?.amountMinor ?? 0)).toBe(20)
    expect(toMajor(result.totalDeductionsMinor)).toBe(20)
    expect(toMajor(result.netSalaryMinor)).toBe(toMajor(result.grossEarningsMinor) - 20)
  })

  it('deducts nothing when no Labour Welfare Fund contribution is due for the month', () => {
    const result = calculatePayrollItem(baseInput())
    expect(result.components.find((entry) => entry.code === 'LWF_EMPLOYEE')).toBeUndefined()
  })

  it('adds a released PL Wages credit as an earning, excluded from the statutory wage', () => {
    const result = calculatePayrollItem(
      baseInput({
        plWages: { id: 'pl-1', amountMinor: toMinor(3_800), note: 'PL Wages for 2025 (5 day(s) at 760.00/day)' },
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      }),
    )

    const line = result.components.find((entry) => entry.code === 'PL_WAGES')
    expect(line).toMatchObject({ name: 'PL Wages', componentType: 'EARNING', referenceId: 'pl-1' })
    expect(toMajor(line?.amountMinor ?? 0)).toBe(3_800)
    expect(toMajor(result.grossEarningsMinor)).toBe(45_800)
    // PF stays on the structure's wage (42,000, capped at the 15,000 ceiling) - unaffected by the credit.
    expect(toMajor(result.pfWageMinor)).toBe(15_000)
  })

  it('adds nothing when no PL Wages credit is released for the month', () => {
    const result = calculatePayrollItem(baseInput())
    expect(result.components.find((entry) => entry.code === 'PL_WAGES')).toBeUndefined()
  })

  it('excludes bonus and overtime pay from the PF and ESI wage base', () => {
    // Structure alone is 10,000 - comfortably under both the 15,000 PF
    // ceiling and the 21,000 ESI limit, so any bonus/OT leaking into the
    // statutory wage would show up directly in pfWageMinor/esiWageMinor
    // rather than being masked by the ceiling.
    const result = calculatePayrollItem(
      baseInput({
        components: [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(10_000) })],
        bonuses: [
          {
            id: 'bonus-1',
            code: 'FESTIVAL',
            name: 'Festival Bonus',
            amountType: 'FIXED_AMOUNT',
            amountMinor: toMinor(5_000),
            percentage: 0,
            taxable: true,
          },
        ],
        overtime: [{ hours: 10, basis: 'CUSTOM', dayDivisor: null, ratePerHourMinor: toMinor(500) }],
        pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
        esi: { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) },
      }),
    )

    // Gross earnings include the bonus and OT ...
    expect(toMajor(result.grossEarningsMinor)).toBe(20_000)
    // ... but the statutory wage stays at the structure's 10,000, uninflated.
    expect(toMajor(result.pfWageMinor)).toBe(10_000)
    expect(toMajor(result.esiWageMinor)).toBe(10_000)

    const pfEmployee = result.components.find((entry) => entry.code === 'PF_EMPLOYEE')
    expect(toMajor(pfEmployee?.amountMinor ?? 0)).toBe(1_200) // 12% of 10,000
    const esiEmployee = result.components.find((entry) => entry.code === 'ESI_EMPLOYEE')
    expect(toMajor(esiEmployee?.amountMinor ?? 0)).toBe(75) // 0.75% of 10,000, rounded up
  })

  it('warns when deductions exceed earnings', () => {
    const result = calculatePayrollItem(
      baseInput({
        adjustments: [
          {
            id: 'adj-1',
            code: 'RECOVERY',
            name: 'Large Recovery',
            componentType: 'DEDUCTION',
            amountMinor: toMinor(50_000),
            reason: 'Correction',
          },
        ],
      }),
    )

    expect(result.netSalaryMinor).toBeLessThan(0)
    expect(result.warnings.some((warning) => warning.includes('negative net salary'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mid-month joiners and leavers
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - partial months', () => {
  it('pays a mid-month joiner only for their employed days', () => {
    const days = septemberDays().map((day) =>
      day.date < '2026-09-16' ? { ...day, isEmployed: false, status: null } : day,
    )

    const result = calculatePayrollItem(baseInput({ days }))

    // 16 to 30 September is 15 employed days, all paid.
    expect(result.attendance.calendarDays).toBe(15)
    expect(result.attendance.paidDays).toBe(15)
    expect(result.attendance.payableDaysBasis).toBe(15)
    // Basis and paid days match, so the full gross is due for the shortened period.
    expect(toMajor(result.grossEarningsMinor)).toBe(42_000)
  })

  it('stops paying a leaver after their exit date', () => {
    const days = septemberDays().map((day) =>
      day.date > '2026-09-15' ? { ...day, isEmployed: false, status: null } : day,
    )

    const result = calculatePayrollItem(baseInput({ days }))

    expect(result.attendance.calendarDays).toBe(15)
    expect(result.attendance.paidDays).toBe(15)
  })

  it('prorates a joiner who is also absent', () => {
    const days = septemberDays({ '2026-09-17': { status: 'ABSENT' } }).map((day) =>
      day.date < '2026-09-16' ? { ...day, isEmployed: false, status: null } : day,
    )

    const result = calculatePayrollItem(baseInput({ days }))

    // 14 paid of 15 employed days: 42,000 x 14/15 = 39,200.
    expect(result.attendance.paidDays).toBe(14)
    expect(toMajor(result.grossEarningsMinor)).toBe(39_200)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('calculatePayrollItem - reproducibility', () => {
  it('produces identical output for identical input', () => {
    const input = baseInput({
      pf: { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 },
      bonuses: [
        {
          id: 'bonus-1',
          code: 'PERF',
          name: 'Performance',
          amountType: 'PERCENTAGE',
          amountMinor: 0,
          percentage: 5,
          taxable: true,
        },
      ],
      days: septemberDays({
        '2026-09-03': { status: 'ABSENT' },
        '2026-09-10': { status: 'HALF_DAY_LEAVE', leaveIsPaid: false },
      }),
    })

    const first = calculatePayrollItem(input)
    const second = calculatePayrollItem(input)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('keeps every money value an integer number of paise', () => {
    const result = calculatePayrollItem(
      baseInput({
        overrideTotalMinor: toMinor(33_333.33),
        days: septemberDays({ '2026-09-03': { status: 'ABSENT' } }),
      }),
    )

    for (const entry of result.components) {
      expect(Number.isInteger(entry.amountMinor)).toBe(true)
    }
    expect(Number.isInteger(result.netSalaryMinor)).toBe(true)
    // Scaling and proration must not lose the override total.
    const earnings = result.components
      .filter((entry) => entry.componentType === 'EARNING')
      .reduce((total, entry) => total + entry.fullAmountMinor, 0)
    expect(earnings).toBe(toMinor(33_333.33))
  })
})

describe('calculatePayrollItem - overtime', () => {
  const pf = { applicable: true, employeeRate: 12, employerRate: 12, wageLimitMinor: toMinor(15_000), epsRate: 8.33 }
  const esi = { applicable: true, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: toMinor(21_000) }
  const dailyWorker = { id: 'emp-2', code: 'EMP002', name: 'Daily Worker', salaryBasis: 'DAILY' } as const
  /** A daily structure paying 556 a day: Basic 350 + DA 206. */
  const dailyComponents = [
    component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(350), displayOrder: 1 }),
    component({ code: 'DA', name: 'Dearness Allowance', amountMinor: toMinor(206), displayOrder: 2 }),
  ]
  const daySalary = (hours: number, dayDivisor = 8) =>
    ({ hours, basis: 'DAY_SALARY', dayDivisor, ratePerHourMinor: null }) as const
  const custom = (hours: number, ratePerHour: number) =>
    ({ hours, basis: 'CUSTOM', dayDivisor: null, ratePerHourMinor: toMinor(ratePerHour) }) as const
  const overtimeLine = (result: ReturnType<typeof calculatePayrollItem>) =>
    result.components.find((entry) => entry.code === 'OVERTIME')

  it('pays one day\'s salary / 8 an hour, with nothing deducted from it', () => {
    const input = { employee: dailyWorker, components: dailyComponents, pf, esi }
    const without = calculatePayrollItem(baseInput(input))
    const result = calculatePayrollItem(baseInput({ ...input, overtime: [daySalary(8)] }))

    // 8 hours at 556 / 8 = 69.50 an hour is exactly one day: 556.
    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(556)
    expect(overtimeLine(result)?.notes).toBe("8 hour(s) at 69.50/hour (one day's salary 556 / 8)")
    // PF and ESI are unchanged and the whole 556 reaches net.
    expect(result.totalDeductionsMinor).toBe(without.totalDeductionsMinor)
    expect(result.pfWageMinor).toBe(without.pfWageMinor)
    expect(result.esiWageMinor).toBe(without.esiWageMinor)
    expect(toMajor(result.netSalaryMinor - without.netSalaryMinor)).toBe(556)
  })

  it('divides the day by whatever n the entry chose', () => {
    // 556 / 12 an hour: 6 hours are half a day, 278.
    const result = calculatePayrollItem(
      baseInput({ employee: dailyWorker, components: dailyComponents, overtime: [daySalary(6, 12)] }),
    )
    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(278)
    expect(overtimeLine(result)?.notes).toBe("6 hour(s) at 46.33/hour (one day's salary 556 / 12)")
  })

  it('takes a monthly structure\'s day at the rate its proration uses', () => {
    // 42,000 over a 30-day basis is 1,400 a day, 175 an hour: 4 hours = 700.
    const result = calculatePayrollItem(baseInput({ overtime: [daySalary(4)] }))
    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(700)
    expect(toMajor(result.grossEarningsMinor)).toBe(42_700)
  })

  it('works out part of an hourly rate in one step, so the paise are not lost', () => {
    const components = [component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(919) })]
    const result = calculatePayrollItem(baseInput({ employee: dailyWorker, components, overtime: [daySalary(5)] }))
    // 919 x 5 / 8 = 574.375, not 5 x a rounded 114.88 = 574.40.
    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(574.38)
  })

  it('pays a custom amount per hour, with nothing deducted from it', () => {
    const input = { employee: dailyWorker, components: dailyComponents, pf, esi }
    const without = calculatePayrollItem(baseInput(input))
    const result = calculatePayrollItem(baseInput({ ...input, overtime: [custom(8, 100)] }))

    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(800)
    expect(overtimeLine(result)?.notes).toBe('8 hour(s) at 100/hour')
    expect(result.totalDeductionsMinor).toBe(without.totalDeductionsMinor)
    expect(toMajor(result.netSalaryMinor - without.netSalaryMinor)).toBe(800)
  })

  it('adds hours recorded at different rates into one overtime line', () => {
    const result = calculatePayrollItem(
      baseInput({ employee: dailyWorker, components: dailyComponents, overtime: [daySalary(4), custom(2, 150)] }),
    )
    // 4 x 69.50 = 278, plus 2 x 150 = 300.
    expect(toMajor(overtimeLine(result)?.amountMinor ?? 0)).toBe(578)
    expect(overtimeLine(result)?.notes).toBe("4 hour(s) at 69.50/hour (one day's salary 556 / 8); 2 hour(s) at 150/hour")
    expect(result.components.filter((entry) => entry.code === 'OVERTIME')).toHaveLength(1)
  })

  it('warns rather than paying nothing silently when the day\'s salary is zero', () => {
    const components = [component({ code: 'FIXED', name: 'Fixed Pay', amountMinor: toMinor(20_000), prorate: false })]
    const result = calculatePayrollItem(baseInput({ components, overtime: [daySalary(6)] }))
    expect(overtimeLine(result)).toBeUndefined()
    expect(result.warnings).toContain('6 overtime hour(s) are recorded but their rate works out to zero; they were not paid.')
  })
})
