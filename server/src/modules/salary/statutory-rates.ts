import { addDays, type IsoDate } from '../../utils/dates.js'

/**
 * A structure's PF and ESI settings change over time, so they are kept as
 * periods: each is in force from its start date until the day before the next
 * one starts, and the latest runs on with no end. The first period has no
 * start date - it covers every date before the first dated change.
 */
export interface DatedPeriod {
  effective_from: IsoDate | null
}

/** Oldest first: the undated first period, then by start date. */
export function sortPeriods<T extends DatedPeriod>(periods: T[]): T[] {
  return [...periods].sort((a, b) => (a.effective_from ?? '').localeCompare(b.effective_from ?? ''))
}

/** The period in force on a date: the latest one that has started by then. */
export function periodInForce<T extends DatedPeriod>(periods: T[], onDate: IsoDate): T | null {
  let found: T | null = null
  for (const period of periods) {
    if (period.effective_from !== null && period.effective_from > onDate) continue
    if (found === null || (found.effective_from ?? '') < (period.effective_from ?? '')) found = period
  }
  return found
}

/** Each period, oldest first, with the last day it is in force (null for the latest). */
export function withEffectiveTo<T extends DatedPeriod>(periods: T[]): { period: T; effectiveTo: IsoDate | null }[] {
  const sorted = sortPeriods(periods)
  return sorted.map((period, index) => {
    const next = sorted[index + 1]
    return { period, effectiveTo: next?.effective_from ? addDays(next.effective_from, -1) : null }
  })
}
