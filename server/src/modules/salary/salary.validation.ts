import { z } from 'zod'
import { isoDateSchema, salaryBasisSchema } from '../employees/employees.validation.js'
import { codeSchema } from '../organization/organization.validation.js'

export const calculationTypeSchema = z.enum(['FIXED', 'PERCENTAGE'])

/** Salary amounts are always non-negative (plan section 54). */
export const amountSchema = z.coerce.number().min(0, 'Amount must be zero or more').max(99_999_999)
export const percentageSchema = z.coerce.number().min(0).max(100)

/**
 * A salary component is always a fixed, taxable, attendance-prorated earning:
 * only its name, code and active flag are configurable (plan: simplified
 * salary module, no calculation-type or percentage-base choices). Whether it
 * counts toward the PF/ESI wage is no longer a per-component choice - the
 * whole structure's gross does, capped by the structure's own PF/ESI settings.
 */
export const salaryComponentSchema = z.object({
  name: z.string().trim().min(2, 'A component name is required').max(120),
  code: codeSchema,
  isActive: z.boolean().default(true),
})

export const updateSalaryComponentSchema = salaryComponentSchema

export const structureComponentSchema = z.object({
  salaryComponentId: z.string().uuid(),
  calculationType: calculationTypeSchema.default('FIXED'),
  amount: amountSchema.default(0),
  percentage: percentageSchema.default(0),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
})

export const salaryStructureSchema = z.object({
  name: z.string().trim().min(2, 'A structure name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(300).nullish(),
  salaryBasis: salaryBasisSchema.default('MONTHLY'),
  currencyCode: z.string().trim().toUpperCase().length(3).default('INR'),
  isActive: z.boolean().default(true),
  components: z.array(structureComponentSchema).min(1, 'Add at least one salary component').max(50),
  // PF is deducted, on both sides, on the wage up to pfWageCeiling; ESI
  // applies, on both sides, only when the wage is at or below esiWageLimit
  // (plan: simplified salary module - rates and limits live on the
  // structure, not a separate organization-wide statutory rule).
  pfEmployeeRate: percentageSchema.default(12),
  pfEmployerRate: percentageSchema.default(12),
  pfWageCeiling: amountSchema.default(15_000),
  /** Share of pfEmployerRate that goes to the Pension Scheme (EPS). */
  pfEpsRate: percentageSchema.default(8.33),
  esiEmployeeRate: percentageSchema.default(0.75),
  esiEmployerRate: percentageSchema.default(3.25),
  esiWageLimit: amountSchema.default(21_000),
})

export const updateSalaryStructureSchema = salaryStructureSchema

export const assignSalarySchema = z
  .object({
    salaryStructureId: z.string().uuid('A salary structure is required'),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullish(),
    /**
     * Optional per-employee total: the monthly gross for a MONTHLY structure, or
     * the daily rate for a DAILY one. Components are scaled proportionally.
     */
    overrideAmount: amountSchema.nullish(),
    notes: z.string().trim().max(300).nullish(),
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

export const salaryHistoryQuerySchema = z.object({
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
})

export type SalaryComponentInput = z.infer<typeof salaryComponentSchema>
export type SalaryStructureInput = z.infer<typeof salaryStructureSchema>
export type AssignSalaryInput = z.infer<typeof assignSalarySchema>
