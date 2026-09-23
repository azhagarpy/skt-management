import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { codeSchema } from '../organization/organization.validation.js'

export const leaveRequestStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])

export const leaveTypeSchema = z.object({
  name: z.string().trim().min(2, 'A leave type name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(300).nullish(),
  annualLimit: z.coerce.number().min(0).max(365).nullish(),
  isPaid: z.boolean().default(true),
  requiresApproval: z.boolean().default(true),
  allowHalfDay: z.boolean().default(true),
  excludeWeeklyOff: z.boolean().default(true),
  excludeHolidays: z.boolean().default(true),
  sandwichHolidays: z.boolean().default(true),
  maxConsecutiveDays: z.coerce.number().int().min(1).max(365).nullish(),
  requiresAttachment: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

export const updateLeaveTypeSchema = leaveTypeSchema.partial()

export const leavePolicySchema = z
  .object({
    leaveTypeId: z.string().uuid(),
    name: z.string().trim().min(2, 'A policy name is required').max(120),
    employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN']).nullish(),
    departmentId: z.string().uuid().nullish(),
    accrualPeriod: z.enum(['ANNUAL', 'MONTHLY', 'QUARTERLY', 'NONE']).default('ANNUAL'),
    accrualAmount: z.coerce.number().min(0).max(365).default(0),
    openingBalance: z.coerce.number().min(0).max(365).default(0),
    carryForwardAllowed: z.boolean().default(false),
    maxCarryForward: z.coerce.number().min(0).max(365).nullish(),
    allowNegativeBalance: z.boolean().default(false),
    minServiceDays: z.coerce.number().int().min(0).max(3650).default(0),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullish(),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'The end date cannot be before the start date',
      })
    }
  })

export const updateLeavePolicySchema = leavePolicySchema

export const createLeaveRequestSchema = z
  .object({
    /** Omitted by employees applying for themselves. */
    employeeId: z.string().uuid().optional(),
    leaveTypeId: z.string().uuid('A leave type is required'),
    fromDate: isoDateSchema,
    toDate: isoDateSchema,
    dayPortion: z.enum(['FULL_DAY', 'HALF_DAY']).default('FULL_DAY'),
    reason: z.string().trim().min(3, 'A reason is required').max(500),
    attachmentId: z.string().uuid().nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.toDate < value.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'The end date cannot be before the start date',
      })
    }
    if (value.dayPortion === 'HALF_DAY' && value.fromDate !== value.toDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dayPortion'],
        message: 'A half day request must cover a single date',
      })
    }
  })

export const decisionSchema = z.object({
  comment: z.string().trim().max(500).optional(),
})

export const rejectSchema = z.object({
  comment: z.string().trim().min(3, 'A reason is required when rejecting').max(500),
})

export const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export const leaveRequestListQuerySchema = paginationSchema.extend({
  status: leaveRequestStatusSchema.optional(),
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
  leaveTypeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
})

export const balanceQuerySchema = z.object({
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
})

export const balanceAdjustmentSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  year: z.coerce.number().int().min(1970).max(2200),
  adjustment: z.coerce.number().min(-365).max(365),
  reason: z.string().trim().min(3, 'A reason is required').max(300),
})

export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>
export type LeavePolicyInput = z.infer<typeof leavePolicySchema>
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>
export type DecisionInput = z.infer<typeof decisionSchema>
export type RejectInput = z.infer<typeof rejectSchema>
export type CancelInput = z.infer<typeof cancelSchema>
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>
export type BalanceQuery = z.infer<typeof balanceQuerySchema>
export type BalanceAdjustmentInput = z.infer<typeof balanceAdjustmentSchema>
