import { describe, expect, it } from 'vitest'
import { assessEmployees } from './pl-wages.module.js'

/**
 * assessEmployees against the numbers in the reference spreadsheet
 * (2025 - PL Wages - All.xlsx) and the plan's own worked examples, so the
 * eligibility gate and the rounding convention stay pinned to real numbers.
 */

const line = (month: number, daysWorked: number, grossEarnings: number, paidDays: number) => ({
  employee_id: 'emp-1',
  month,
  days_worked: String(daysWorked),
  gross_earnings: String(grossEarnings),
  paid_days: String(paidDays),
})

/** assessEmployees for a single employee's lines, asserting there is exactly one result. */
function assessOne(lines: Parameters<typeof assessEmployees>[0]): ReturnType<typeof assessEmployees>[number] {
  const results = assessEmployees(lines)
  expect(results).toHaveLength(1)
  const [result] = results
  if (!result) throw new Error('expected exactly one assessment')
  return result
}

describe('assessEmployees', () => {
  it('matches the spreadsheet: 306 days worked across 12 qualifying months -> 15 eligible days at 760/day', () => {
    // BALAKRISHNAN M's row: Jan-Dec days [24,27,24,26,25,27,26,26,25,25,26,25] = 306 total.
    const days = [24, 27, 24, 26, 25, 27, 26, 26, 25, 25, 26, 25]
    const lines = days.map((value, index) => line(index + 1, value, value * 760, value))

    const result = assessOne(lines)
    expect(result.qualifyingMonths).toBe(12)
    expect(result.totalDaysWorked).toBe(306)
    expect(result.eligibleDays).toBe(15) // 306 / 20 = 15.3 -> 15
    expect(result.dailyWageRate).toBe(760)
    expect(result.creditAmount).toBe(15 * 760)
  })

  it('rounds half up: 312.5 days -> 16 eligible days, not 15', () => {
    // OPPILAMANI U's row: [27,27,24,26,26,25.5,26,27,26,26,27,25] = 312.5 total.
    const days = [27, 27, 24, 26, 26, 25.5, 26, 27, 26, 26, 27, 25]
    const lines = days.map((value, index) => line(index + 1, value, value * 760, value))

    const result = assessOne(lines)
    expect(result.totalDaysWorked).toBe(312.5)
    expect(result.eligibleDays).toBe(16) // 312.5 / 20 = 15.625 -> 16
  })

  it('is not eligible at all with fewer than 3 qualifying months, even with high total days', () => {
    // 25 days a month for 2 months, then nothing - only 2 qualifying months.
    const lines = [line(1, 25, 25 * 700, 25), line(2, 25, 25 * 700, 25)]

    const result = assessOne(lines)
    expect(result.qualifyingMonths).toBe(2)
    expect(result.eligibleDays).toBe(0)
    expect(result.creditAmount).toBe(0)
  })

  it('matches the plan example: 6 months worked, 140 days total -> 7 eligible days', () => {
    // 6 qualifying months averaging just over 23 days each, totalling 140.
    const days = [24, 24, 23, 23, 23, 23]
    const lines = days.map((value, index) => line(index + 1, value, value * 800, value))

    const result = assessOne(lines)
    expect(result.qualifyingMonths).toBe(6)
    expect(result.totalDaysWorked).toBe(140)
    expect(result.eligibleDays).toBe(7) // 140 / 20 = 7 exactly
  })

  it('a month with fewer than 20 days still counts toward the total, just not toward the gate', () => {
    // 3 qualifying months (20 each) plus one short month (10) = 70 total days,
    // but qualifying months is still 3 since only the >=20 months count for the gate.
    const lines = [line(1, 20, 20 * 500, 20), line(2, 20, 20 * 500, 20), line(3, 20, 20 * 500, 20), line(4, 10, 10 * 500, 10)]

    const result = assessOne(lines)
    expect(result.qualifyingMonths).toBe(3)
    expect(result.totalDaysWorked).toBe(70)
    expect(result.eligibleDays).toBe(4) // 70 / 20 = 3.5 -> 4
  })

  it('takes the daily rate from the most recent month with paid days, not an earlier or empty one', () => {
    const lines = [
      line(1, 25, 25 * 700, 25),
      line(2, 25, 25 * 700, 25),
      line(3, 25, 25 * 700, 25),
      line(11, 0, 0, 0), // no work recorded
      line(12, 26, 26 * 800, 26), // latest, higher rate
    ]

    const result = assessOne(lines)
    expect(result.dailyWageRate).toBe(800)
  })

  it('keeps each employee separate', () => {
    const lines = [
      { ...line(1, 25, 25 * 700, 25), employee_id: 'emp-a' },
      { ...line(1, 5, 5 * 500, 5), employee_id: 'emp-b' },
    ]
    const results = assessEmployees(lines)
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.employeeId === 'emp-a')?.dailyWageRate).toBe(700)
    expect(results.find((r) => r.employeeId === 'emp-b')?.dailyWageRate).toBe(500)
  })
})
