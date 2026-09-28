import { describe, expect, it } from 'vitest'
import { calendarQuerySchema } from './attendance.validation.js'

/** The attendance calendar serves a month or a week, never an open-ended range. */
describe('calendarQuerySchema', () => {
  it('accepts a whole month and a week', () => {
    expect(calendarQuerySchema.safeParse({ from: '2026-08-01', to: '2026-08-31' }).success).toBe(true)
    expect(calendarQuerySchema.safeParse({ from: '2026-09-14', to: '2026-09-20' }).success).toBe(true)
  })

  it('accepts a six-week grid but nothing longer', () => {
    expect(calendarQuerySchema.safeParse({ from: '2026-08-01', to: '2026-09-11' }).success).toBe(true)
    expect(calendarQuerySchema.safeParse({ from: '2026-08-01', to: '2026-09-12' }).success).toBe(false)
  })

  it('refuses an end date before the start', () => {
    expect(calendarQuerySchema.safeParse({ from: '2026-09-20', to: '2026-09-14' }).success).toBe(false)
  })

  it('takes the same optional filters as the daily sheet, plus one employee', () => {
    const parsed = calendarQuerySchema.safeParse({
      from: '2026-09-01',
      to: '2026-09-30',
      departmentId: '6f1c1f0e-8a5e-4c55-9d6c-3e2b9b0a7c11',
      employeeId: '494b6af4-0a07-4144-a5ad-b85a02c577ad',
      search: 'SENT0007',
    })
    expect(parsed.success).toBe(true)
    expect(calendarQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-30', employeeId: 'me' }).success).toBe(false)
  })
})
