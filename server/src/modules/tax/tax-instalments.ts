/**
 * Spreading professional tax across the half-year instead of taking it in one
 * month.
 *
 * P.Tax is a half-yearly figure the company pays to the local body, but payroll
 * is calculated on the 20th/21st and paid on the 1st of the next month. An
 * employee who stops turning up after that has taken the company's money with
 * them, so the tax is recovered a month at a time as wages are earned rather
 * than in a single deduction at the end of the half-year.
 *
 * Every month recomputes the instalment from what is still owed and how many
 * months are left to collect it in. That one rule covers the awkward cases on
 * its own:
 *
 *  - A month with no deduction (long leave, or an employee who was not on the
 *    payroll yet) is simply a month that collected nothing; the months that
 *    remain each carry a little more.
 *  - Rounding never accumulates, because the next instalment is derived from
 *    the exact outstanding balance rather than from the original estimate.
 *  - The final month collects whatever is left, to the paisa.
 */
import type { IsoDate } from '../../utils/dates.js'

export interface HalfYearMonth {
  year: number
  month: number
}

export interface HalfYear {
  /** 'APR_SEP' (April-September) or 'OCT_MAR' (October-March). */
  code: 'APR_SEP' | 'OCT_MAR'
  from: IsoDate
  to: IsoDate
  months: HalfYearMonth[]
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * The professional-tax half-year a payroll month belongs to.
 *
 * April-September and October-March, the Tamil Nadu half-years. October-March
 * straddles the new year, so January to March belong to the half-year that
 * started in the previous October.
 */
export function halfYearFor(year: number, month: number): HalfYear {
  if (month >= 4 && month <= 9) {
    return {
      code: 'APR_SEP',
      from: `${year}-04-01`,
      to: `${year}-09-30`,
      months: [4, 5, 6, 7, 8, 9].map((m) => ({ year, month: m })),
    }
  }
  const startYear = month >= 10 ? year : year - 1
  return {
    code: 'OCT_MAR',
    from: `${startYear}-10-01`,
    to: `${startYear + 1}-03-31`,
    months: [
      { year: startYear, month: 10 },
      { year: startYear, month: 11 },
      { year: startYear, month: 12 },
      { year: startYear + 1, month: 1 },
      { year: startYear + 1, month: 2 },
      { year: startYear + 1, month: 3 },
    ],
  }
}

/** Months of the half-year from this one onwards, this one included. */
export function monthsRemainingInHalfYear(year: number, month: number): number {
  const half = halfYearFor(year, month)
  const index = half.months.findIndex((m) => m.year === year && m.month === month)
  return index === -1 ? 0 : half.months.length - index
}

export interface InstalmentInput {
  /** The half-year's whole tax, from the slab the employee's wages fall in. */
  totalTax: number
  /** What earlier months of this half-year have already taken. */
  alreadyDeducted: number
  /** Months left to collect in, including the month being calculated. */
  monthsRemaining: number
}

/**
 * The amount to deduct in this month.
 *
 * Rounded to whole rupees except in the last month, which takes the exact
 * balance so the half-year collects the slab amount and not a paisa more.
 */
export function instalmentFor({ totalTax, alreadyDeducted, monthsRemaining }: InstalmentInput): number {
  const outstanding = round2(totalTax - alreadyDeducted)
  if (outstanding <= 0) return 0

  // Past the end of the half-year, or on its last month: collect the balance.
  // Leaving it would mean never collecting it at all.
  if (monthsRemaining <= 1) return outstanding

  const share = Math.round(outstanding / monthsRemaining)
  // Never propose more than is owed, and never stall on zero while a balance
  // remains - a tiny balance is collected rather than carried forever.
  return Math.min(outstanding, Math.max(share, 1))
}

/**
 * The whole schedule for one employee, for showing an administrator what the
 * remaining months will each take if nothing changes.
 *
 * Later months are an estimate: they assume the employee stays on the same
 * slab, which a change in wages would alter. The figure actually deducted is
 * always recomputed for that month.
 */
export function instalmentSchedule(
  totalTax: number,
  alreadyDeducted: number,
  year: number,
  month: number,
): { year: number; month: number; amount: number }[] {
  const half = halfYearFor(year, month)
  const startIndex = half.months.findIndex((m) => m.year === year && m.month === month)
  if (startIndex === -1) return []

  const schedule: { year: number; month: number; amount: number }[] = []
  let collected = alreadyDeducted
  for (let i = startIndex; i < half.months.length; i += 1) {
    const slot = half.months[i]!
    const amount = instalmentFor({
      totalTax,
      alreadyDeducted: collected,
      monthsRemaining: half.months.length - i,
    })
    schedule.push({ year: slot.year, month: slot.month, amount })
    collected = round2(collected + amount)
  }
  return schedule
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
