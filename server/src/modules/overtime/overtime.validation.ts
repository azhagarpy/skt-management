import { z } from 'zod'
import { isoDateSchema } from '../employees/employees.validation.js'

export const overtimeHoursSchema = z.coerce.number().positive('Hours must be greater than zero').max(24)

/**
 * What a paid-hourly entry's hour is worth: one day's salary / `dayDivisor`
 * hours, or a custom `ratePerHour` in rupees. Left out, it is one day's salary / 8.
 */
const overtimeRateFields = {
  rateBasis: z.enum(['DAY_SALARY', 'CUSTOM']).optional(),
  dayDivisor: z.coerce.number().positive('The hours in a day must be greater than zero').max(24).nullish(),
  ratePerHour: z.coerce.number().min(0, 'The amount per hour cannot be negative').max(999_999).nullish(),
}

function requireCustomRate(value: { rateBasis?: 'DAY_SALARY' | 'CUSTOM'; ratePerHour?: number | null }, ctx: z.RefinementCtx) {
  if (value.rateBasis === 'CUSTOM' && (value.ratePerHour === null || value.ratePerHour === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ratePerHour'], message: 'Enter the amount per hour' })
  }
}

export const recordOvertimeSchema = z
  .object({
    employeeId: z.string().uuid('A valid employee is required'),
    workDate: isoDateSchema,
    hours: overtimeHoursSchema,
    remarks: z.string().trim().max(300).nullish(),
    ...overtimeRateFields,
  })
  .superRefine(requireCustomRate)

/** Rate fields left out keep the entry's current rate. */
export const updateOvertimeSchema = z
  .object({
    hours: overtimeHoursSchema,
    remarks: z.string().trim().max(300).nullish(),
    ...overtimeRateFields,
  })
  .superRefine(requireCustomRate)

export const overtimeListQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
})

export const overtimeEmployeeQuerySchema = z.object({
  employeeId: z.string().uuid(),
  /** The entry's date, for the day's salary in force then. */
  date: isoDateSchema,
})

export const overtimeWeekQuerySchema = z.object({
  employeeId: z.string().uuid(),
  /** Any date within the ISO week (Monday-Sunday) to summarise. */
  date: isoDateSchema,
})

/** A Supply employee's paid offs (paid-offs.ts): everyone the caller can see who has one, or one employee. */
export const paidOffListQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
})

/** An employee's days over a stretch (up to about two months), for choosing a paid off date. */
export const paidOffCalendarQuerySchema = z
  .object({
    employeeId: z.string().uuid(),
    from: isoDateSchema,
    to: isoDateSchema,
  })
  .refine((query) => query.to >= query.from, { path: ['to'], message: 'The end date cannot be before the start date' })
  .refine((query) => new Date(query.to).getTime() - new Date(query.from).getTime() <= 62 * 86_400_000, {
    path: ['to'],
    message: 'Ask for at most two months at a time',
  })

/** Gives one earned paid off a date. */
export const schedulePaidOffSchema = z.object({
  employeeId: z.string().uuid('A valid employee is required'),
  date: isoDateSchema,
})

export type RecordOvertimeInput = z.infer<typeof recordOvertimeSchema>
export type UpdateOvertimeInput = z.infer<typeof updateOvertimeSchema>
export type OvertimeListQuery = z.infer<typeof overtimeListQuerySchema>
export type OvertimeWeekQuery = z.infer<typeof overtimeWeekQuerySchema>
export type OvertimeEmployeeQuery = z.infer<typeof overtimeEmployeeQuerySchema>
export type PaidOffListQuery = z.infer<typeof paidOffListQuerySchema>
export type SchedulePaidOffInput = z.infer<typeof schedulePaidOffSchema>
export type PaidOffCalendarQuery = z.infer<typeof paidOffCalendarQuerySchema>
