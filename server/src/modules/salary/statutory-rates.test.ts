import { describe, expect, it } from 'vitest'
import { periodInForce, sortPeriods, withEffectiveTo } from './statutory-rates.js'

const first = { effective_from: null, rate: 8 }
const april = { effective_from: '2026-04-01', rate: 9.5 }
const october = { effective_from: '2026-10-01', rate: 10 }

describe('periodInForce', () => {
  it('uses the undated first period before any dated change', () => {
    expect(periodInForce([october, first, april], '2026-03-31')).toBe(first)
  })

  it('switches to a dated period on its start date and keeps it until the next one', () => {
    const periods = [first, april, october]
    expect(periodInForce(periods, '2026-04-01')).toBe(april)
    expect(periodInForce(periods, '2026-09-30')).toBe(april)
    expect(periodInForce(periods, '2026-10-01')).toBe(october)
    expect(periodInForce(periods, '2030-01-01')).toBe(october)
  })

  it('finds nothing before the first period when every period is dated', () => {
    expect(periodInForce([april, october], '2026-03-31')).toBeNull()
    expect(periodInForce([], '2026-03-31')).toBeNull()
  })
})

describe('withEffectiveTo', () => {
  it('ends each period the day before the next starts, and leaves the latest open', () => {
    expect(withEffectiveTo([october, april, first])).toEqual([
      { period: first, effectiveTo: '2026-03-31' },
      { period: april, effectiveTo: '2026-09-30' },
      { period: october, effectiveTo: null },
    ])
  })

  it('leaves a lone period open', () => {
    expect(withEffectiveTo([first])).toEqual([{ period: first, effectiveTo: null }])
  })
})

describe('sortPeriods', () => {
  it('puts the undated first period ahead of the dated ones, without changing the input', () => {
    const input = [october, april, first]
    expect(sortPeriods(input)).toEqual([first, april, october])
    expect(input).toEqual([october, april, first])
  })
})
