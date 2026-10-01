import { describe, expect, it } from 'vitest'
import { calculatePayrollItem, type CalculatorInput, type ComponentInput, type DayInput } from '../payroll/payroll.calculator.js'
import { datesInMonth, weekdayOf } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { registerHolidayFigures } from './report-amounts.js'

const component = (overrides: Partial<ComponentInput> & Pick<ComponentInput, 'code' | 'name'>): ComponentInput => ({
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
})

// SKT's daily structure: Basic 494 + DA 287, and a Special Allowance of 138 left out of holiday pay.
const SKT_DAILY = [
  component({ code: 'BASIC', name: 'Basic', amountMinor: toMinor(494), displayOrder: 1 }),
  component({ code: 'DA', name: 'Dearness Allowance', amountMinor: toMinor(287), displayOrder: 2 }),
  component({ code: 'SA', name: 'Special Allowance', amountMinor: toMinor(138), displayOrder: 3, holidayExtraPay: false }),
]

/** September 2026 with weekends off (unpaid, as SKT's payroll has it) and every weekday worked. */
function september(overrides: Record<string, Partial<DayInput>>): DayInput[] {
  return datesInMonth(2026, 9).map((date) => {
    const weekend = weekdayOf(date) === 'SATURDAY' || weekdayOf(date) === 'SUNDAY'
    const day: DayInput = {
      date,
      dayKind: weekend ? 'WEEKLY_OFF' : 'WORKING',
      status: weekend ? 'WEEKLY_OFF' : 'PRESENT',
      leaveIsPaid: null,
      isEmployed: true,
    }
    return { ...day, ...(overrides[date] ?? {}) }
  })
}

function calculate(days: DayInput[], components = SKT_DAILY, salaryBasis: 'DAILY' | 'MONTHLY' = 'DAILY') {
  const input: CalculatorInput = {
    period: { year: 2026, month: 9, start: '2026-09-01', end: '2026-09-30' },
    employee: { id: 'emp-1', code: 'EMP001', name: 'Worker', salaryBasis },
    days,
    components,
    overrideTotalMinor: null,
    overtime: [],
    tax: null,
    lwf: null,
    adjustments: [],
    pf: { applicable: false, employeeRate: 12, employerRate: 12, wageLimitMinor: 0, epsRate: 0 },
    esi: { applicable: false, employeeRate: 0.75, employerRate: 3.25, wageLimitMinor: 0 },
    policy: {
      paidDaysBasis: 'CALENDAR_DAYS',
      halfDayPaidFraction: 1,
      halfDayUnpaidFraction: 0.5,
      countHolidaysAsPaid: true,
      countWeeklyOffAsPaid: false,
      prorateOnJoining: true,
      prorateOnExit: true,
      netRoundingDecimals: 2,
    },
  }
  const result = calculatePayrollItem(input)
  const figures = registerHolidayFigures({
    days,
    presentDays: result.attendance.presentDays,
    halfDayLeaveDays: result.attendance.halfDayLeaveDays,
    restedHolidays: result.attendance.holidayDays,
    holidayExtraPayMinor: result.components.find((entry) => entry.source === 'HOLIDAY_WORK')?.amountMinor ?? 0,
    salary: { components, overrideTotalMinor: null, salaryBasis },
    payableDaysBasis: result.attendance.payableDaysBasis,
  })
  return { result, figures }
}

describe('registerHolidayFigures', () => {
  // A worked holiday (Wed 9th), a rested one (Mon 14th), one lost to absences on
  // both sides (Wed 23rd) and a half day of unpaid leave (Fri 25th).
  const days = september({
    '2026-09-09': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true },
    '2026-09-14': { dayKind: 'HOLIDAY', status: 'HOLIDAY', holidayExtraPay: true },
    '2026-09-22': { status: 'ABSENT' },
    '2026-09-23': { dayKind: 'HOLIDAY', status: 'HOLIDAY', holidayExtraPay: true, holidayForfeited: true },
    '2026-09-24': { status: 'ABSENT' },
    '2026-09-25': { status: 'HALF_DAY_LEAVE', leaveIsPaid: false },
  })

  it('counts every day worked, the worked holiday included, and the holidays that earn holiday pay', () => {
    const { figures } = calculate(days)
    // 22 weekdays, less the rested holiday, two absences, the forfeited holiday
    // and the half day: 17 days worked (the 9th among them) and half of the 25th.
    expect(figures.workingDays).toBe(17.5)
    // The rested 14th and the worked 9th; the forfeited 23rd earns nothing.
    expect(figures.eligibleHolidays).toBe(2)
    // Each at Basic + DA, without the Special Allowance: 781 each.
    expect(toMajor(figures.holidayWagesMinor)).toBe(1_562)
  })

  it('adds up to gross: every day worked at the full day rate, plus the holiday wages', () => {
    const { result, figures } = calculate(days)
    expect(toMajor(result.grossEarningsMinor)).toBe(toMajor(figures.workingDays * toMinor(919) + figures.holidayWagesMinor))
  })

  it('does not count a holiday worked that pays no extra for it', () => {
    const { figures } = calculate(september({ '2026-09-09': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: false } }))
    expect(figures.workingDays).toBe(22)
    expect(figures.eligibleHolidays).toBe(0)
    expect(figures.holidayWagesMinor).toBe(0)
  })

  it('counts half a holiday worked as half an eligible holiday', () => {
    const { figures } = calculate(september({ '2026-09-09': { dayKind: 'HOLIDAY', status: 'HALF_DAY_LEAVE', holidayExtraPay: true } }))
    expect(figures.workingDays).toBe(21.5)
    expect(figures.eligibleHolidays).toBe(0.5)
    expect(toMajor(figures.holidayWagesMinor)).toBe(390.5)
  })

  it('prices a rested holiday on a monthly structure at the day rate proration uses, without the Special Allowance', () => {
    const monthly = [
      component({ code: 'BASIC', name: 'Basic Salary', amountMinor: toMinor(25_000), displayOrder: 1 }),
      component({ code: 'HRA', name: 'House Rent Allowance', amountMinor: toMinor(10_000), displayOrder: 2 }),
      component({ code: 'SA', name: 'Special Allowance', amountMinor: toMinor(5_000), displayOrder: 3, holidayExtraPay: false }),
    ]
    const { figures } = calculate(september({ '2026-09-14': { dayKind: 'HOLIDAY', status: 'HOLIDAY' } }), monthly, 'MONTHLY')
    // Basic 25,000 / 30 = 833.33 and HRA 10,000 / 30 = 333.33, each rounded as payroll rounds it.
    expect(figures.eligibleHolidays).toBe(1)
    expect(toMajor(figures.holidayWagesMinor)).toBe(1_166.66)
  })

  it('still shows the extra pay when the structure can no longer be found', () => {
    const figures = registerHolidayFigures({
      days: september({ '2026-09-09': { dayKind: 'HOLIDAY', status: 'PRESENT', holidayExtraPay: true } }),
      presentDays: 22,
      halfDayLeaveDays: 0,
      restedHolidays: 1,
      holidayExtraPayMinor: toMinor(781),
      salary: null,
      payableDaysBasis: 30,
    })
    expect(figures.eligibleHolidays).toBe(2)
    expect(toMajor(figures.holidayWagesMinor)).toBe(781)
  })
})
