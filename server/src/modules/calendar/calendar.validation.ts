import { z } from 'zod'
import { isoDateSchema } from '../employees/employees.validation.js'
import { codeSchema } from '../organization/organization.validation.js'

export const weekdaySchema = z.enum([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
])

/**
 * One weekday within a weekly off rule.
 *   occurrences omitted / null -> every occurrence ("every Sunday")
 *   occurrences [2, 4]         -> 2nd and 4th occurrence ("2nd and 4th Saturday")
 *   includeLast                -> also the final occurrence of the month
 */
export const weeklyOffDaySchema = z.object({
  weekday: weekdaySchema,
  occurrences: z.array(z.coerce.number().int().min(1).max(5)).min(1).max(5).nullish(),
  includeLast: z.boolean().default(false),
  isHalfDay: z.boolean().default(false),
})

export const weeklyOffRuleSchema = z
  .object({
    name: z.string().trim().min(2, 'A rule name is required').max(120),
    description: z.string().trim().max(300).nullish(),
    departmentId: z.string().uuid().nullish(),
    locationId: z.string().uuid().nullish(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullish(),
    priority: z.coerce.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
    days: z.array(weeklyOffDaySchema).min(1, 'Select at least one weekly off day').max(7),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'The end date cannot be before the start date',
      })
    }
    const seen = new Set<string>()
    for (const day of value.days) {
      if (seen.has(day.weekday)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['days'], message: `${day.weekday} is listed twice` })
      }
      seen.add(day.weekday)
    }
  })

export const updateWeeklyOffRuleSchema = weeklyOffRuleSchema

export const holidayCalendarSchema = z.object({
  name: z.string().trim().min(2, 'A calendar name is required').max(120),
  year: z.coerce.number().int().min(1970).max(2200),
  locationId: z.string().uuid().nullish(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

export const holidaySchema = z.object({
  calendarId: z.string().uuid().nullish(),
  name: z.string().trim().min(2, 'A holiday name is required').max(120),
  holidayDate: isoDateSchema,
  description: z.string().trim().max(300).nullish(),
  isOptional: z.boolean().default(false),
  isPaid: z.boolean().default(true),
  extraPayIfWorked: z.boolean().default(false),
})

export const updateHolidaySchema = holidaySchema.partial()

export const holidayListQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  calendarId: z.string().uuid().optional(),
})

export const shiftSchema = z.object({
  name: z.string().trim().min(2, 'A shift name is required').max(120),
  code: codeSchema,
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:MM')
    .nullish(),
  endTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:MM')
    .nullish(),
  breakMinutes: z.coerce.number().int().min(0).max(480).default(0),
  isNightShift: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

export const updateShiftSchema = shiftSchema.partial()

export const workingDaysQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
})

// ---------------------------------------------------------------------------
// Per-employee weekly off assignments
// ---------------------------------------------------------------------------

/** Assign a recurring weekday off to a set of employees, from a chosen week onward. */
export const assignWeeklyOffSchema = z.object({
  weekday: weekdaySchema,
  /** The Monday (or any date) of the first week this applies to. */
  effectiveFrom: isoDateSchema,
  employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee').max(500),
})

/** Grant a one-off weekly off on a specific date, not a recurring pattern. */
export const grantOneOffWeeklyOffSchema = z.object({
  offDate: isoDateSchema,
  employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee').max(500),
})

/**
 * Remove a weekly off starting from a given date, whichever kind granted it: a
 * one-off grant on that exact date, and/or a recurring assignment that would
 * otherwise keep covering it and every date after.
 */
export const unassignWeeklyOffSchema = z.object({
  date: isoDateSchema,
  employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee').max(500),
})

export const weeklyOffCalendarQuerySchema = z.object({
  weekStart: isoDateSchema,
  /** Defaults to one week; the full-screen month calendar asks for a whole visible grid at once. */
  days: z.coerce.number().int().min(1).max(42).default(7),
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
})

export type WeeklyOffRuleInput = z.infer<typeof weeklyOffRuleSchema>
export type HolidayInput = z.infer<typeof holidaySchema>
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>
export type HolidayCalendarInput = z.infer<typeof holidayCalendarSchema>
export type HolidayListQuery = z.infer<typeof holidayListQuerySchema>
export type ShiftInput = z.infer<typeof shiftSchema>
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>
export type WorkingDaysQuery = z.infer<typeof workingDaysQuerySchema>
export type AssignWeeklyOffInput = z.infer<typeof assignWeeklyOffSchema>
export type GrantOneOffWeeklyOffInput = z.infer<typeof grantOneOffWeeklyOffSchema>
export type UnassignWeeklyOffInput = z.infer<typeof unassignWeeklyOffSchema>
export type WeeklyOffCalendarQuery = z.infer<typeof weeklyOffCalendarQuerySchema>
