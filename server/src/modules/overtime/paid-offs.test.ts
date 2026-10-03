import { describe, expect, it } from 'vitest'
import { overtimeRemovalBlocked, paidOffBalance, paidOffsForWeek } from './paid-offs.js'

describe('paidOffsForWeek', () => {
  it('earns one paid off for each full 8 hours in the week', () => {
    expect(paidOffsForWeek(0)).toBe(0)
    expect(paidOffsForWeek(7.5)).toBe(0)
    expect(paidOffsForWeek(8)).toBe(1)
    expect(paidOffsForWeek(15.5)).toBe(1)
    expect(paidOffsForWeek(16)).toBe(2)
  })

  it('earns at most 2 in one week', () => {
    expect(paidOffsForWeek(24)).toBe(2)
    expect(paidOffsForWeek(40)).toBe(2)
  })
})

describe('paidOffBalance', () => {
  const off = (id: string, source: 'PAID_OFF' | 'OVERTIME_CONVERSION', date = '2026-10-07') => ({ id, off_date: date, source })

  it('adds up each week on its own: short hours do not carry into the next week', () => {
    // 6 + 6 hours in two weeks earn nothing; 8 and 20 earn 1 and 2.
    expect(paidOffBalance([6, 6, 8, 20], []).earned).toBe(3)
  })

  it('takes the scheduled paid offs out of what is earned', () => {
    const balance = paidOffBalance([16, 8], [off('a', 'PAID_OFF', '2026-10-07'), off('b', 'PAID_OFF', '2026-10-09')])
    expect(balance).toEqual({
      earned: 3,
      convertedBefore: 0,
      scheduled: [
        { id: 'a', date: '2026-10-07' },
        { id: 'b', date: '2026-10-09' },
      ],
      available: 1,
    })
  })

  it('counts overtime already turned into an extra weekly off before paid offs as used', () => {
    expect(paidOffBalance([16], [off('a', 'OVERTIME_CONVERSION')]).available).toBe(1)
  })

  it('never shows less than nothing to schedule', () => {
    expect(paidOffBalance([], [off('a', 'OVERTIME_CONVERSION')]).available).toBe(0)
  })
})

describe('overtimeRemovalBlocked', () => {
  // Week of Mon 28 Sept 2026: 9 hours, which earn one paid off.
  const weeks = [{ week_start: '2026-09-28', hours: 9 }]
  const scheduled = [{ id: 'a', off_date: '2026-10-07', source: 'PAID_OFF' as const }]

  it('lets overtime go while the paid off it earned has no date', () => {
    expect(overtimeRemovalBlocked(weeks, [], '2026-10-03', 9)).toBe(false)
  })

  it('keeps overtime once the paid off it earned is scheduled', () => {
    expect(overtimeRemovalBlocked(weeks, scheduled, '2026-10-03', 9)).toBe(true)
  })

  it('lets the hours beyond what earned the scheduled paid off go', () => {
    // 9 hours earned it; dropping one still leaves 8.
    expect(overtimeRemovalBlocked(weeks, scheduled, '2026-10-01', 1)).toBe(false)
  })

  it('lets overtime go when other weeks still earn every scheduled paid off', () => {
    const twoWeeks = [...weeks, { week_start: '2026-10-05', hours: 8 }]
    expect(overtimeRemovalBlocked(twoWeeks, scheduled, '2026-10-03', 9)).toBe(false)
  })
})
