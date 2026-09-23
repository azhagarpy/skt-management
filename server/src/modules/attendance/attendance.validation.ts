import { z } from 'zod'
import { isoDateSchema } from '../employees/employees.validation.js'

/**
 * Status-based attendance only (plan section 4). There is deliberately no
 * check-in, check-out, break, GPS, biometric, working-hours or overtime input.
 */
export const attendanceStatusSchema = z.enum([
  'PRESENT',
  'ABSENT',
  'ON_LEAVE',
  'HALF_DAY_LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
])

export const markAttendanceSchema = z
  .object({
    employeeId: z.string().uuid('A valid employee is required'),
    attendanceDate: isoDateSchema,
    status: attendanceStatusSchema,
    leaveTypeId: z.string().uuid().nullish(),
    shiftId: z.string().uuid().nullish(),
    remarks: z.string().trim().max(300).nullish(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === 'ON_LEAVE' || value.status === 'HALF_DAY_LEAVE') && !value.leaveTypeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaveTypeId'],
        message: 'A leave type is required when marking leave',
      })
    }
  })

export const bulkMarkAttendanceSchema = z
  .object({
    attendanceDate: isoDateSchema,
    /** Applied to every employee in `employeeIds` when no per-row status is given. */
    defaultStatus: attendanceStatusSchema.optional(),
    employeeIds: z.array(z.string().uuid()).max(2000).optional(),
    entries: z
      .array(
        z.object({
          employeeId: z.string().uuid(),
          status: attendanceStatusSchema,
          leaveTypeId: z.string().uuid().nullish(),
          shiftId: z.string().uuid().nullish(),
          remarks: z.string().trim().max(300).nullish(),
        }),
      )
      .max(2000)
      .optional(),
    remarks: z.string().trim().max(300).nullish(),
  })
  .superRefine((value, ctx) => {
    const hasEntries = (value.entries?.length ?? 0) > 0
    const hasBulk = (value.employeeIds?.length ?? 0) > 0
    if (!hasEntries && !hasBulk) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either entries or employeeIds with a status' })
    }
    if (hasBulk && !value.defaultStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultStatus'],
        message: 'A status is required when marking a list of employees',
      })
    }
  })

export const updateAttendanceSchema = z
  .object({
    status: attendanceStatusSchema,
    leaveTypeId: z.string().uuid().nullish(),
    shiftId: z.string().uuid().nullish(),
    remarks: z.string().trim().max(300).nullish(),
    reason: z.string().trim().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === 'ON_LEAVE' || value.status === 'HALF_DAY_LEAVE') && !value.leaveTypeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaveTypeId'],
        message: 'A leave type is required when marking leave',
      })
    }
  })

/** The daily marking sheet: one row per employee for a single date. */
export const dailySheetQuerySchema = z.object({
  date: isoDateSchema,
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  status: attendanceStatusSchema.optional(),
  unmarkedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional(),
})

export const attendanceListQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
  status: attendanceStatusSchema.optional(),
})

export const monthlyQuerySchema = z.object({
  year: z.coerce.number().int().min(1970).max(2200),
  month: z.coerce.number().int().min(1).max(12),
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
})

export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>
export type BulkMarkAttendanceInput = z.infer<typeof bulkMarkAttendanceSchema>
export type UpdateAttendanceInput = z.infer<typeof updateAttendanceSchema>
export type DailySheetQuery = z.infer<typeof dailySheetQuerySchema>
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>
export type MonthlyQuery = z.infer<typeof monthlyQuerySchema>
