import { describe, expect, it } from 'vitest'
import { ABSENCE_STREAK_DAYS, trailingAbsenceRun, type AttendanceDay } from './absence-alert.js'

type Code = 'P' | 'A' | 'L' | 'HL' | 'H' | 'WO'

const STATUS: Record<Code, AttendanceDay['status']> = {
  P: 'PRESENT',
  A: 'ABSENT',
  L: 'ON_LEAVE',
  HL: 'HALF_DAY_LEAVE',
  H: 'HOLIDAY',
  WO: 'WEEKLY_OFF',
}

/** Builds consecutive days from 2026-03-01 so the cases read as a muster row. */
function days(...codes: Code[]): AttendanceDay[] {
  return codes.map((code, index) => ({
    date: `2026-03-${String(index + 1).padStart(2, '0')}`,
    status: STATUS[code],
  }))
}

describe('trailingAbsenceRun', () => {
  it('returns null when nothing is marked', () => {
    expect(trailingAbsenceRun([])).toBeNull()
  })

  it('returns null when the employee is present on the last day', () => {
    expect(trailingAbsenceRun(days('A', 'A', 'A', 'P'))).toBeNull()
  })

  it('counts a plain run of absences', () => {
    expect(trailingAbsenceRun(days('P', 'A', 'A', 'A'))).toEqual({
      from: '2026-03-02',
      to: '2026-03-04',
      days: 3,
    })
  })

  it('counts only the trailing run, not an earlier one', () => {
    expect(trailingAbsenceRun(days('A', 'A', 'A', 'P', 'A', 'A'))?.days).toBe(2)
  })

  it('lets a weekly off carry the run without counting as an absent day', () => {
    const run = trailingAbsenceRun(days('A', 'A', 'A', 'WO', 'A', 'A', 'A'))
    expect(run?.days).toBe(6)
    expect(run?.from).toBe('2026-03-01')
    expect(run?.to).toBe('2026-03-07')
  })

  it('lets a holiday carry the run too', () => {
    expect(trailingAbsenceRun(days('A', 'H', 'A'))?.days).toBe(2)
  })

  it('ends the run at approved leave, which accounts for the employee', () => {
    expect(trailingAbsenceRun(days('A', 'A', 'L', 'A'))?.days).toBe(1)
  })

  it('ends the run at a half day, which is attendance', () => {
    expect(trailingAbsenceRun(days('A', 'A', 'HL', 'A'))?.days).toBe(1)
  })

  it('does not treat a trailing holiday as the start of a run', () => {
    expect(trailingAbsenceRun(days('P', 'H', 'WO'))).toBeNull()
  })

  it('reaches the alert threshold at seven absent days', () => {
    const run = trailingAbsenceRun(days('P', 'A', 'A', 'A', 'A', 'A', 'A', 'A'))
    expect(run?.days).toBe(ABSENCE_STREAK_DAYS)
  })

  it('still reaches the threshold when offs pad the run out', () => {
    // Seven absences either side of a weekly off spanning nine calendar days.
    const run = trailingAbsenceRun(days('P', 'A', 'A', 'A', 'WO', 'A', 'A', 'A', 'A'))
    expect(run?.days).toBe(ABSENCE_STREAK_DAYS)
    expect(run?.from).toBe('2026-03-02')
  })

  it('is order independent', () => {
    const shuffled = [...days('P', 'A', 'A', 'A')].reverse()
    expect(trailingAbsenceRun(shuffled)?.days).toBe(3)
  })
})
