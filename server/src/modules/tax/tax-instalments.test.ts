import { describe, expect, it } from 'vitest'
import {
  halfYearFor,
  instalmentFor,
  instalmentSchedule,
  monthsRemainingInHalfYear,
} from './tax-instalments.js'

describe('halfYearFor', () => {
  it('puts April to September in the first half-year', () => {
    const half = halfYearFor(2026, 4)
    expect(half.code).toBe('APR_SEP')
    expect(half.from).toBe('2026-04-01')
    expect(half.to).toBe('2026-09-30')
    expect(half.months).toHaveLength(6)
  })

  it('puts October to December in the half-year starting that October', () => {
    const half = halfYearFor(2026, 11)
    expect(half.code).toBe('OCT_MAR')
    expect(half.from).toBe('2026-10-01')
    expect(half.to).toBe('2027-03-31')
  })

  it('puts January to March in the half-year that started the previous October', () => {
    const half = halfYearFor(2027, 2)
    expect(half.from).toBe('2026-10-01')
    expect(half.to).toBe('2027-03-31')
    expect(half.months[0]).toEqual({ year: 2026, month: 10 })
    expect(half.months.at(-1)).toEqual({ year: 2027, month: 3 })
  })
})

describe('monthsRemainingInHalfYear', () => {
  it('counts the current month', () => {
    expect(monthsRemainingInHalfYear(2026, 4)).toBe(6)
    expect(monthsRemainingInHalfYear(2026, 9)).toBe(1)
  })

  it('counts across the new year', () => {
    expect(monthsRemainingInHalfYear(2026, 10)).toBe(6)
    expect(monthsRemainingInHalfYear(2027, 3)).toBe(1)
  })
})

describe('instalmentFor', () => {
  it('splits the tax evenly when nothing has been collected', () => {
    expect(instalmentFor({ totalTax: 1180, alreadyDeducted: 0, monthsRemaining: 6 })).toBe(197)
  })

  it('collects nothing once the tax is fully paid', () => {
    expect(instalmentFor({ totalTax: 1180, alreadyDeducted: 1180, monthsRemaining: 3 })).toBe(0)
  })

  it('collects nothing when the slab is zero', () => {
    expect(instalmentFor({ totalTax: 0, alreadyDeducted: 0, monthsRemaining: 6 })).toBe(0)
  })

  it('takes the whole balance in the last month', () => {
    expect(instalmentFor({ totalTax: 1180, alreadyDeducted: 985, monthsRemaining: 1 })).toBe(195)
  })

  it('takes the balance when the half-year has already ended', () => {
    expect(instalmentFor({ totalTax: 1180, alreadyDeducted: 200, monthsRemaining: 0 })).toBe(980)
  })

  it('never proposes more than is outstanding', () => {
    expect(instalmentFor({ totalTax: 120, alreadyDeducted: 119.5, monthsRemaining: 4 })).toBe(0.5)
  })

  it('carries the extra onto the remaining months after a missed month', () => {
    // Six months, 1180 total. Two months collected 197 each, then a month of
    // long leave collected nothing. Three months are left to find the rest.
    const afterMissedMonth = instalmentFor({
      totalTax: 1180,
      alreadyDeducted: 394,
      monthsRemaining: 3,
    })
    expect(afterMissedMonth).toBe(262)
    expect(afterMissedMonth).toBeGreaterThan(197)
  })
})

describe('instalmentSchedule', () => {
  it('collects exactly the slab amount over the half-year', () => {
    const schedule = instalmentSchedule(1180, 0, 2026, 4)
    expect(schedule).toHaveLength(6)
    const total = schedule.reduce((sum, row) => sum + row.amount, 0)
    expect(total).toBe(1180)
  })

  it('still totals exactly after a mid-year start', () => {
    // Joined late: only three months of the half-year left to collect in.
    const schedule = instalmentSchedule(1180, 0, 2026, 7)
    expect(schedule).toHaveLength(3)
    expect(schedule.reduce((sum, row) => sum + row.amount, 0)) .toBe(1180)
  })

  it('collects only the remainder when earlier months already took some', () => {
    const schedule = instalmentSchedule(1180, 400, 2026, 6)
    expect(schedule.reduce((sum, row) => sum + row.amount, 0)).toBe(780)
  })

  it('runs to the end of the half-year across the new year', () => {
    const schedule = instalmentSchedule(590, 0, 2026, 12)
    expect(schedule.map((row) => `${row.year}-${row.month}`)).toEqual([
      '2026-12',
      '2027-1',
      '2027-2',
      '2027-3',
    ])
    expect(schedule.reduce((sum, row) => sum + row.amount, 0)).toBe(590)
  })

  it('proposes nothing for an employee below the taxable slab', () => {
    const schedule = instalmentSchedule(0, 0, 2026, 4)
    expect(schedule.every((row) => row.amount === 0)).toBe(true)
  })

  it('never lets rounding drift past the total', () => {
    // 1180 over 6 months does not divide evenly; the balance must still land.
    for (const total of [120, 300, 590, 890, 1180]) {
      const schedule = instalmentSchedule(total, 0, 2026, 10)
      expect(schedule.reduce((sum, row) => sum + row.amount, 0)).toBe(total)
    }
  })
})
