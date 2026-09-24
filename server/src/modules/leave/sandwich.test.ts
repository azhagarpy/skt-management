import { describe, expect, it } from 'vitest'
import type { IsoDate } from '../../utils/dates.js'
import { sandwichedHolidayDates } from './leave.service.js'

/**
 * The sandwich rule: a holiday with leave on the day before and the day after
 * is charged as leave too.
 *
 * The calendar is expressed as a map so each case reads as the week it
 * describes. Anything not named is an ordinary working day.
 */
type Kind = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'

function calendar(days: Record<string, Kind>): (date: IsoDate) => Kind {
  return (date) => days[date] ?? 'WORKING'
}

const run = (input: {
  charged?: string[]
  existing?: string[]
  days?: Record<string, Kind>
  from: IsoDate
  to: IsoDate
}): IsoDate[] =>
  sandwichedHolidayDates({
    charged: new Set(input.charged ?? []),
    existing: new Set(input.existing ?? []),
    kindOf: calendar(input.days ?? {}),
    scanFrom: input.from,
    scanTo: input.to,
  })

describe('sandwichedHolidayDates', () => {
  it('charges a holiday that this request brackets on both sides', () => {
    // Thu and Sat taken as leave, Fri is a holiday.
    expect(
      run({
        charged: ['2026-10-01', '2026-10-03'],
        days: { '2026-10-02': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-06',
      }),
    ).toEqual(['2026-10-02'])
  })

  it('charges a holiday bracketed by leave from a different request', () => {
    // This request is Monday alone; Friday was approved earlier and Saturday
    // is a holiday between the two.
    expect(
      run({
        charged: ['2026-10-05'],
        existing: ['2026-10-02'],
        days: { '2026-10-03': 'HOLIDAY', '2026-10-04': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-12',
      }),
    ).toEqual(['2026-10-03', '2026-10-04'])
  })

  it('leaves a holiday at the edge of the leave alone', () => {
    // Leave on Thursday only; the Friday holiday has nothing after it.
    expect(
      run({
        charged: ['2026-10-01'],
        days: { '2026-10-02': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-06',
      }),
    ).toEqual([])
  })

  it('does not charge a sandwich made entirely of older leave', () => {
    // Both sides belong to earlier requests, so this request pays nothing for
    // the holiday between them.
    expect(
      run({
        charged: ['2026-10-09'],
        existing: ['2026-10-01', '2026-10-03'],
        days: { '2026-10-02': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-12',
      }),
    ).toEqual([])
  })

  it('treats a run of consecutive holidays as one sandwich', () => {
    expect(
      run({
        charged: ['2026-10-01', '2026-10-05'],
        days: { '2026-10-02': 'HOLIDAY', '2026-10-03': 'HOLIDAY', '2026-10-04': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-10',
      }),
    ).toEqual(['2026-10-02', '2026-10-03', '2026-10-04'])
  })

  it('breaks the run on a weekly off, which is never charged', () => {
    // Leave, holiday, weekly off, leave: the weekly off ends the run, so the
    // holiday has a weekly off after it rather than leave.
    expect(
      run({
        charged: ['2026-10-01', '2026-10-04'],
        days: { '2026-10-02': 'HOLIDAY', '2026-10-03': 'WEEKLY_OFF' },
        from: '2026-09-28',
        to: '2026-10-08',
      }),
    ).toEqual([])
  })

  it('does not charge a holiday the request is already paying for', () => {
    // exclude_holidays off means the holiday is in `charged` already; it must
    // not be counted a second time.
    expect(
      run({
        charged: ['2026-10-01', '2026-10-02', '2026-10-03'],
        days: { '2026-10-02': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-06',
      }),
    ).toEqual([])
  })

  it('does not charge a holiday an earlier request already sandwiched', () => {
    // Thu and Sat were taken earlier and the Friday holiday was charged then;
    // this request is the following Monday.
    expect(
      run({
        charged: ['2026-10-05'],
        existing: ['2026-10-01', '2026-10-02', '2026-10-03'],
        days: { '2026-10-02': 'HOLIDAY' },
        from: '2026-09-28',
        to: '2026-10-09',
      }),
    ).toEqual([])
  })

  it('finds nothing when there is no holiday in the window', () => {
    expect(run({ charged: ['2026-10-01', '2026-10-02'], from: '2026-09-28', to: '2026-10-06' })).toEqual([])
  })
})
