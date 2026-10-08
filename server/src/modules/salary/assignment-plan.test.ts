import { describe, expect, it } from 'vitest'
import { planAssignment } from './assignment-plan.js'

const april = { id: 'april', effective_from: '2026-04-01', effective_to: '2026-09-30' }
const october = { id: 'october', effective_from: '2026-10-01', effective_to: null }
const timeline = [april, october]

describe('planAssignment', () => {
  it('changes the assignment that already starts on the date, keeping its end', () => {
    expect(planAssignment(timeline, '2026-10-01')).toEqual({ kind: 'REPLACE', target: october, effectiveTo: null })
    expect(planAssignment(timeline, '2026-04-01')).toEqual({ kind: 'REPLACE', target: april, effectiveTo: '2026-09-30' })
  })

  it('splits the ongoing assignment: it ends the day before and the new one runs on', () => {
    expect(planAssignment(timeline, '2026-11-15')).toEqual({
      kind: 'SPLIT',
      target: october,
      targetEndsOn: '2026-11-14',
      effectiveTo: null,
    })
  })

  it('splits a past assignment: the new one ends where it used to end', () => {
    expect(planAssignment(timeline, '2026-07-01')).toEqual({
      kind: 'SPLIT',
      target: april,
      targetEndsOn: '2026-06-30',
      effectiveTo: '2026-09-30',
    })
  })

  it('treats the last day of an assignment as inside it', () => {
    expect(planAssignment(timeline, '2026-09-30')).toMatchObject({ kind: 'SPLIT', target: april, targetEndsOn: '2026-09-29' })
  })

  it('starts before the first assignment and runs until it begins', () => {
    expect(planAssignment(timeline, '2026-01-01')).toEqual({ kind: 'NEW', target: null, effectiveTo: '2026-03-31' })
  })

  it('fills a gap until the next assignment starts', () => {
    const gap = [{ ...april, effective_to: '2026-06-30' }, october]
    expect(planAssignment(gap, '2026-08-01')).toEqual({ kind: 'NEW', target: null, effectiveTo: '2026-09-30' })
  })

  it('runs on after an assignment that already ended, or with none at all', () => {
    expect(planAssignment([april], '2026-12-01')).toEqual({ kind: 'NEW', target: null, effectiveTo: null })
    expect(planAssignment([], '2026-12-01')).toEqual({ kind: 'NEW', target: null, effectiveTo: null })
  })
})
