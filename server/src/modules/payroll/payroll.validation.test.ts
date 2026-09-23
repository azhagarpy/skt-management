import { describe, expect, it } from 'vitest'
import { createRunSchema, updateRunPeriodSchema } from './payroll.validation.js'

describe('createRunSchema', () => {
  it('takes a month alone, leaving the standard cycle to apply', () => {
    const result = createRunSchema.safeParse({ year: 2026, month: 3 })
    expect(result.success).toBe(true)
  })

  it('accepts custom dates for the run', () => {
    const result = createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-03-01', periodEnd: '2026-03-31' })
    expect(result.success).toBe(true)
  })

  it('needs both dates or neither', () => {
    expect(createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-03-01' }).success).toBe(false)
    expect(createRunSchema.safeParse({ year: 2026, month: 3, periodEnd: '2026-03-31' }).success).toBe(false)
  })

  it('rejects a period that ends before it starts, or runs longer than 93 days', () => {
    expect(
      createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-03-31', periodEnd: '2026-03-01' }).success,
    ).toBe(false)
    expect(
      createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-01-01', periodEnd: '2026-06-30' }).success,
    ).toBe(false)
  })

  it('allows a single-day period and one of exactly 93 days', () => {
    expect(
      createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-03-05', periodEnd: '2026-03-05' }).success,
    ).toBe(true)
    // 1 Jan to 3 Apr 2026 is 93 days.
    expect(
      createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-01-01', periodEnd: '2026-04-03' }).success,
    ).toBe(true)
    expect(
      createRunSchema.safeParse({ year: 2026, month: 3, periodStart: '2026-01-01', periodEnd: '2026-04-04' }).success,
    ).toBe(false)
  })
})

describe('updateRunPeriodSchema', () => {
  it('needs both dates, in order', () => {
    expect(updateRunPeriodSchema.safeParse({ periodStart: '2026-03-01', periodEnd: '2026-03-31' }).success).toBe(true)
    expect(updateRunPeriodSchema.safeParse({ periodStart: '2026-03-01' }).success).toBe(false)
    expect(updateRunPeriodSchema.safeParse({ periodStart: '2026-03-31', periodEnd: '2026-03-01' }).success).toBe(false)
  })
})
