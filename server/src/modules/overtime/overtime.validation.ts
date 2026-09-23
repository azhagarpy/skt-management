import { z } from 'zod'
import { isoDateSchema } from '../employees/employees.validation.js'

export const overtimeHoursSchema = z.coerce.number().positive('Hours must be greater than zero').max(24)

export const recordOvertimeSchema = z.object({
  employeeId: z.string().uuid('A valid employee is required'),
  workDate: isoDateSchema,
  hours: overtimeHoursSchema,
  remarks: z.string().trim().max(300).nullish(),
})

export const updateOvertimeSchema = z.object({
  hours: overtimeHoursSchema,
  remarks: z.string().trim().max(300).nullish(),
})

export const overtimeListQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
})

export const overtimeWeekQuerySchema = z.object({
  employeeId: z.string().uuid(),
  /** Any date within the ISO week (Monday-Sunday) to summarise. */
  date: isoDateSchema,
})

export type RecordOvertimeInput = z.infer<typeof recordOvertimeSchema>
export type UpdateOvertimeInput = z.infer<typeof updateOvertimeSchema>
export type OvertimeListQuery = z.infer<typeof overtimeListQuerySchema>
export type OvertimeWeekQuery = z.infer<typeof overtimeWeekQuerySchema>
