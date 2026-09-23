import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import { countDaysBetween } from '../../utils/dates.js'

/** The longest a single payroll run may cover; a month is the norm, this leaves room for odd cycles. */
export const MAX_RUN_DAYS = 93

/** Both dates or neither; the end not before the start; and not longer than MAX_RUN_DAYS. */
function checkRunPeriod(value: { periodStart?: string; periodEnd?: string }, ctx: z.RefinementCtx): void {
  if (!value.periodStart && !value.periodEnd) return
  if (!value.periodStart || !value.periodEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.periodStart ? 'periodEnd' : 'periodStart'],
      message: 'Give both the start and the end of the period',
    })
    return
  }
  if (value.periodEnd < value.periodStart) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'The period ends before it starts' })
  } else if (countDaysBetween(value.periodStart, value.periodEnd) > MAX_RUN_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['periodEnd'],
      message: `A payroll period can be at most ${MAX_RUN_DAYS} days`,
    })
  }
}

export const createRunSchema = z
  .object({
    year: z.coerce.number().int().min(1970).max(2200),
    month: z.coerce.number().int().min(1).max(12),
    name: z.string().trim().max(120).nullish(),
    notes: z.string().trim().max(500).nullish(),
    /** The dates the run covers. Left out, the standard cycle for the month is used. */
    periodStart: isoDateSchema.optional(),
    periodEnd: isoDateSchema.optional(),
  })
  .superRefine(checkRunPeriod)

/** Changes the dates a run covers (and nothing else about it). */
export const updateRunPeriodSchema = z
  .object({
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
  })
  .superRefine(checkRunPeriod)

export const runListQuerySchema = paginationSchema.extend({
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  status: z.enum(['DRAFT', 'CALCULATED', 'UNDER_REVIEW', 'APPROVED', 'LOCKED']).optional(),
})

export const itemListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  paymentStatus: z.enum(['PENDING', 'PARTIALLY_PAID', 'PAID']).optional(),
})

export const myPayrollQuerySchema = z.object({
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(12),
})

/**
 * An adjustment corrects a locked run without editing it: the amount is carried
 * into a later payroll month (plan section 33).
 */
export const adjustmentCreateSchema = z.object({
  employeeId: z.string().uuid(),
  sourcePayrollItemId: z.string().uuid().nullish(),
  adjustmentType: z.enum(['CORRECTION', 'REVERSAL', 'ARREAR', 'RECOVERY']),
  componentCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(24)
    .regex(/^[A-Z0-9_-]+$/, 'Code may contain letters, digits, hyphen and underscore only'),
  componentName: z.string().trim().min(2).max(120),
  componentType: z.enum(['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION']),
  amount: z.coerce
    .number()
    .refine((value) => value !== 0, 'An adjustment amount cannot be zero')
    .refine((value) => Math.abs(value) <= 99_999_999, 'Amount is out of range'),
  applyYear: z.coerce.number().int().min(1970).max(2200),
  applyMonth: z.coerce.number().int().min(1).max(12),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
})

export const adjustmentListQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  appliedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional(),
  /** Narrows to adjustments whose component code starts with this, e.g. "OD_" for Other Deductions. */
  componentCodePrefix: z.string().trim().max(24).optional(),
})

export type CreateRunInput = z.infer<typeof createRunSchema>
export type RunListQuery = z.infer<typeof runListQuerySchema>
export type ItemListQuery = z.infer<typeof itemListQuerySchema>
export type MyPayrollQuery = z.infer<typeof myPayrollQuerySchema>
export type AdjustmentCreateInput = z.infer<typeof adjustmentCreateSchema>
export type AdjustmentListQuery = z.infer<typeof adjustmentListQuerySchema>

export type UpdateRunPeriodInput = z.infer<typeof updateRunPeriodSchema>
