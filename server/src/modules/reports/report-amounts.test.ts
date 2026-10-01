import { describe, expect, it } from 'vitest'
import {
  calculatePayrollItem,
  type CalculatorInput,
  type ComponentInput,
  type DayInput,
  type DayKind,
} from '../payroll/payroll.calculator.js'
import { employeeDays } from '../payroll/payroll.service.js'
import type { CalendarContext, DayInfo } from '../calendar/calendar.service.js'
import { datesBetween, datesInMonth, weekdayOf, type IsoDate } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { isPaidRestedHoliday, registerHolidayFigures } from './report-amounts.js'

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

describe('isPaidRestedHoliday', () => {
  // Mon 14 September 2026 is the holiday; weekends are weekly offs.
  const HOLIDAY: IsoDate = '2026-09-14'
  const dates = datesBetween('2026-09-07', '2026-09-21')

  function calendarWith(kinds: Record<IsoDate, DayKind>): CalendarContext {
    const dayFor = (date: IsoDate): DayInfo => {
      const weekend = weekdayOf(date) === 'SATURDAY' || weekdayOf(date) === 'SUNDAY'
      const kind = kinds[date] ?? (weekend ? 'WEEKLY_OFF' : 'WORKING')
      return {
        date,
        kind,
        isHalfWeeklyOff: false,
        holidayId: null,
        holidayName: kind === 'HOLIDAY' ? 'Vinayakar Chaturthi' : null,
        holidayIsOptional: false,
        holidayIsPaid: true,
        holidayExtraPay: kind === 'HOLIDAY',
      }
    }
    return {
      from: dates[0] as IsoDate,
      to: dates[dates.length - 1] as IsoDate,
      dayFor,
      daysFor: () => dates.map((date) => dayFor(date)),
      countWorkingDays: () => 0,
    }
  }

  /** Whether the 14th is paid as a rested holiday, given the marked days around it. */
  function paid(
    marked: Record<IsoDate, string>,
    options: { kinds?: Record<IsoDate, DayKind>; leavePaid?: Record<IsoDate, boolean>; exitDate?: IsoDate } = {},
  ): boolean {
    const days = employeeDays(
      dates,
      calendarWith(options.kinds ?? { [HOLIDAY]: 'HOLIDAY' }),
      { id: 'emp-1', department_id: null, location_id: null, joining_date: '2020-01-01', exit_date: options.exitDate ?? null },
      new Map(Object.entries(marked).map(([date, status]) => [date as IsoDate, { status }])),
      new Map(Object.entries(options.leavePaid ?? {}) as [IsoDate, boolean][]),
    )
    return isPaidRestedHoliday(days.find((day) => day.date === HOLIDAY) as DayInput)
  }

  const workedAround = { '2026-09-11': 'PRESENT', '2026-09-15': 'PRESENT' }

  it('pays a holiday marked as one', () => {
    expect(paid({ ...workedAround, [HOLIDAY]: 'HOLIDAY' })).toBe(true)
  })

  it('pays a holiday never marked, when the calendar keeps the day a holiday', () => {
    expect(paid(workedAround)).toBe(true)
  })

  it('does not pay an unmarked holiday that falls on the employee\'s weekly off', () => {
    expect(paid(workedAround, { kinds: { [HOLIDAY]: 'WEEKLY_OFF' } })).toBe(false)
  })

  it('does not count a holiday worked or taken absent as rested', () => {
    expect(paid({ ...workedAround, [HOLIDAY]: 'PRESENT' })).toBe(false)
    expect(paid({ ...workedAround, [HOLIDAY]: 'ABSENT' })).toBe(false)
  })

  it('loses the holiday to absences on the days right next to it', () => {
    expect(paid({ '2026-09-13': 'ABSENT', [HOLIDAY]: 'HOLIDAY', '2026-09-15': 'ABSENT' })).toBe(false)
  })

  it('keeps the holiday when a weekly off sits between it and an absence', () => {
    // Fri 11th and Tue 15th absent, but Sunday the 13th is a weekly off.
    expect(paid({ '2026-09-11': 'ABSENT', [HOLIDAY]: 'HOLIDAY', '2026-09-15': 'ABSENT' })).toBe(true)
  })

  it('keeps the holiday when only one side is an absence', () => {
    expect(paid({ '2026-09-13': 'ABSENT', [HOLIDAY]: 'HOLIDAY', '2026-09-15': 'PRESENT' })).toBe(true)
  })

  it('loses the holiday to half days or unpaid leave on both sides, but not to paid leave', () => {
    expect(paid({ '2026-09-13': 'HALF_DAY_LEAVE', [HOLIDAY]: 'HOLIDAY', '2026-09-15': 'HALF_DAY_LEAVE' })).toBe(false)
    const leave = { '2026-09-13': 'ON_LEAVE', [HOLIDAY]: 'HOLIDAY', '2026-09-15': 'ON_LEAVE' }
    expect(paid(leave, { leavePaid: { '2026-09-13': false, '2026-09-15': false } })).toBe(false)
    expect(paid(leave, { leavePaid: { '2026-09-13': true, '2026-09-15': true } })).toBe(true)
  })

  it('does not pay a holiday after the employee left', () => {
    expect(paid(workedAround, { exitDate: '2026-09-11' })).toBe(false)
  })
})
