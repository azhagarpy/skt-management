import { z } from 'zod'
import { isoDateSchema, salaryBasisSchema } from '../employees/employees.validation.js'
import { codeSchema } from '../organization/organization.validation.js'

export const calculationTypeSchema = z.enum(['FIXED', 'PERCENTAGE'])

/** Salary amounts are always non-negative (plan section 54). */
export const amountSchema = z.coerce.number().min(0, 'Amount must be zero or more').max(99_999_999)
export const percentageSchema = z.coerce.number().min(0).max(100)

/**
 * A salary component is always a fixed, taxable, attendance-prorated earning:
 * only its name, code, active flag and whether it is part of holiday work pay
 * are configurable (plan: simplified salary module, no calculation-type or
 * percentage-base choices). Whether it counts toward the PF/ESI wage is no
 * longer a per-component choice - the whole structure's gross does, capped by
 * the structure's own PF/ESI settings.
 */
export const salaryComponentSchema = z.object({
  name: z.string().trim().min(2, 'A component name is required').max(120),
  code: codeSchema,
  isActive: z.boolean().default(true),
  /** False leaves the component out of the extra day earned by working a holiday. */
  holidayExtraPay: z.boolean().default(true),
})

export const updateSalaryComponentSchema = salaryComponentSchema

export const structureComponentSchema = z.object({
  salaryComponentId: z.string().uuid(),
  calculationType: calculationTypeSchema.default('FIXED'),
  amount: amountSchema.default(0),
  percentage: percentageSchema.default(0),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
})

// PF is deducted, on both sides, on the wage up to pfWageCeiling; ESI applies,
// on both sides, only when a standard month's wage is at or below
// esiWageLimit, on the wage up to it. These change over time, so a structure
// keeps them as dated periods (statutory-rates.ts) rather than one value.
const statutoryRateFields = {
  pfEmployeeRate: percentageSchema,
  pfEmployerRate: percentageSchema,
  pfWageCeiling: amountSchema,
  /** Share of pfEmployerRate that goes to the Pension Scheme (EPS). */
  pfEpsRate: percentageSchema,
  esiEmployeeRate: percentageSchema,
  esiEmployerRate: percentageSchema,
  esiWageLimit: amountSchema,
}

/**
 * A structure's name, components and other details. Its PF and ESI periods are
 * managed on their own (statutoryRateSchema), so an update leaves them alone.
 */
export const updateSalaryStructureSchema = z.object({
  name: z.string().trim().min(2, 'A structure name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(300).nullish(),
  salaryBasis: salaryBasisSchema.default('MONTHLY'),
  currencyCode: z.string().trim().toUpperCase().length(3).default('INR'),
  isActive: z.boolean().default(true),
  components: z.array(structureComponentSchema).min(1, 'Add at least one salary component').max(50),
})

/** A new structure also takes its first PF and ESI period, which has no start date. */
export const salaryStructureSchema = updateSalaryStructureSchema.extend({
  pfEmployeeRate: statutoryRateFields.pfEmployeeRate.default(12),
  pfEmployerRate: statutoryRateFields.pfEmployerRate.default(12),
  pfWageCeiling: statutoryRateFields.pfWageCeiling.default(15_000),
  pfEpsRate: statutoryRateFields.pfEpsRate.default(8.33),
  esiEmployeeRate: statutoryRateFields.esiEmployeeRate.default(0.75),
  esiEmployerRate: statutoryRateFields.esiEmployerRate.default(3.25),
  esiWageLimit: statutoryRateFields.esiWageLimit.default(21_000),
})

/**
 * One period of PF and ESI settings. `effectiveFrom` is null only for a
 * structure's first period, which covers every date before the next one.
 */
export const statutoryRateSchema = z.object({
  effectiveFrom: isoDateSchema.nullable(),
  ...statutoryRateFields,
})

export const statutoryRateParams = z.object({ id: z.string().uuid(), rateId: z.string().uuid() })

/**
 * A salary assignment starts on any date and runs until the employee's next
 * assignment starts (assignment-plan.ts), so it takes no end date of its own.
 */
const assignmentFields = {
  salaryStructureId: z.string().uuid('A salary structure is required'),
  effectiveFrom: isoDateSchema,
  /**
   * Optional per-employee total: the monthly gross for a MONTHLY structure, or
   * the daily rate for a DAILY one. Components are scaled proportionally.
   */
  overrideAmount: amountSchema.nullish(),
  notes: z.string().trim().max(300).nullish(),
}

export const assignSalarySchema = z.object(assignmentFields)

/** The same assignment for many employees at once. */
export const bulkAssignSalarySchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee').max(2000),
  ...assignmentFields,
})

export const assignmentsOnDateQuery = z.object({ date: isoDateSchema.optional() })

export const salaryHistoryQuerySchema = z.object({
  employeeId: z.union([z.literal('me'), z.string().uuid()]).optional(),
})

export type SalaryComponentInput = z.infer<typeof salaryComponentSchema>
export type SalaryStructureInput = z.infer<typeof salaryStructureSchema>
export type UpdateSalaryStructureInput = z.infer<typeof updateSalaryStructureSchema>
export type StatutoryRateInput = z.infer<typeof statutoryRateSchema>
export type AssignSalaryInput = z.infer<typeof assignSalarySchema>
export type BulkAssignSalaryInput = z.infer<typeof bulkAssignSalarySchema>
