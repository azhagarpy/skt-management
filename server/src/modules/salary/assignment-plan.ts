import { addDays, type IsoDate } from '../../utils/dates.js'

/**
 * An employee's salary assignments form a timeline: each runs from its start
 * date to its end date (null while ongoing), and no two overlap. A new
 * assignment can start on any date; this works out what that does to the
 * timeline, without touching the database.
 */
export interface DatedAssignment {
  id: string
  effective_from: IsoDate
  effective_to: IsoDate | null
}

export type AssignmentPlan<T extends DatedAssignment> =
  /** One already starts on the date: it is changed in place, keeping its end. */
  | { kind: 'REPLACE'; target: T; effectiveTo: IsoDate | null }
  /**
   * The date falls inside an assignment: that one now ends the day before, and
   * the new one runs to where it used to end.
   */
  | { kind: 'SPLIT'; target: T; targetEndsOn: IsoDate; effectiveTo: IsoDate | null }
  /** The date is in no assignment: the new one runs until the next one starts, or on. */
  | { kind: 'NEW'; target: null; effectiveTo: IsoDate | null }

export function planAssignment<T extends DatedAssignment>(existing: T[], effectiveFrom: IsoDate): AssignmentPlan<T> {
  const sameDay = existing.find((assignment) => assignment.effective_from === effectiveFrom)
  if (sameDay) return { kind: 'REPLACE', target: sameDay, effectiveTo: sameDay.effective_to }

  const covering = existing.find(
    (assignment) =>
      assignment.effective_from < effectiveFrom &&
      (assignment.effective_to === null || assignment.effective_to >= effectiveFrom),
  )
  if (covering) {
    return {
      kind: 'SPLIT',
      target: covering,
      targetEndsOn: addDays(effectiveFrom, -1),
      effectiveTo: covering.effective_to,
    }
  }

  const next = existing
    .filter((assignment) => assignment.effective_from > effectiveFrom)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0]
  return { kind: 'NEW', target: null, effectiveTo: next ? addDays(next.effective_from, -1) : null }
}
