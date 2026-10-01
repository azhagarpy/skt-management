import { describe, expect, it } from 'vitest'
import type { DayInput } from '../payroll/payroll.calculator.js'
import { holidayDaysWorked } from './report-amounts.js'

const day = (overrides: Partial<DayInput>): DayInput => ({
  date: '2026-09-14',
  dayKind: 'HOLIDAY',
  status: 'PRESENT',
  leaveIsPaid: null,
  isEmployed: true,
  ...overrides,
})

describe('holidayDaysWorked', () => {
  it('counts a holiday worked in full as one day and a half day as half', () => {
    expect(holidayDaysWorked([day({}), day({ date: '2026-09-15', status: 'HALF_DAY_LEAVE' })])).toBe(1.5)
  })

  it('leaves out a holiday rested, a working day, and a day before joining', () => {
    expect(
      holidayDaysWorked([
        day({ status: 'HOLIDAY' }),
        day({ status: null }),
        day({ dayKind: 'WORKING' }),
        day({ isEmployed: false }),
      ]),
    ).toBe(0)
  })

  it('counts a worked holiday whether or not it offers extra pay', () => {
    expect(holidayDaysWorked([day({ holidayExtraPay: false }), day({ holidayExtraPay: true })])).toBe(2)
  })
})
