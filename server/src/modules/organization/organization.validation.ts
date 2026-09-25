import { z } from 'zod'

export const uuidParam = (name = 'id') => z.object({ [name]: z.string().uuid('A valid id is required') })

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+]?[0-9][0-9\s-]{7,17}$/, 'Enter a valid phone number')

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4,10}$/, 'Enter a valid pincode')

/** A 6-digit hex colour. Normalised to lower case so the DB check constraint holds. */
export const hexColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Enter a colour as a 6-digit hex value, for example #5b54d6')

export const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Code must be at least 2 characters')
  .max(24, 'Code must be at most 24 characters')
  .regex(/^[A-Z0-9_-]+$/, 'Code may contain letters, digits, hyphen and underscore only')

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  legalName: z.string().trim().max(200).nullish(),
  email: z.string().trim().toLowerCase().email().max(254).nullish(),
  phone: phoneSchema.nullish(),
  website: z.string().trim().url('Enter a valid URL').max(200).nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(100).nullish(),
  country: z.string().trim().max(100).optional(),
  pincode: pincodeSchema.nullish(),
  pfNumber: z.string().trim().max(40).nullish(),
  esiNumber: z.string().trim().max(60).nullish(),
  labourIdentificationNumber: z.string().trim().max(40).nullish(),
  currencyCode: z.string().trim().toUpperCase().length(3).optional(),
  timezone: z.string().trim().max(64).optional(),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
  themeColor: hexColorSchema.optional(),
})

export const departmentSchema = z.object({
  name: z.string().trim().min(2, 'Department name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(500).nullish(),
  parentDepartmentId: z.string().uuid().nullish(),
  headEmployeeId: z.string().uuid().nullish(),
  isActive: z.boolean().optional().default(true),
})

export const updateDepartmentSchema = departmentSchema.partial()

/**
 * A supply type declares how its overtime is treated. There is no default:
 * whoever adds a type has to say which rule applies, because a type the rules
 * do not cover would lose its employees' overtime silently.
 */
export const employeeTypeSchema = z.object({
  name: z.string().trim().min(2, 'Type name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(500).nullish(),
  overtimeHandling: z.enum(['OFF_IN_LIEU', 'PAID_HOURLY'], {
    required_error: 'Choose how overtime is handled for this type',
  }),
  displayOrder: z.coerce.number().int().min(0).max(999).optional().default(0),
  isActive: z.boolean().optional().default(true),
})

export const updateEmployeeTypeSchema = employeeTypeSchema.partial()

export const designationSchema = z.object({
  name: z.string().trim().min(2, 'Section name is required').max(120),
  code: codeSchema,
  description: z.string().trim().max(500).nullish(),
  departmentId: z.string().uuid().nullish(),
  level: z.coerce.number().int().min(0).max(50).nullish(),
  isActive: z.boolean().optional().default(true),
})

export const updateDesignationSchema = designationSchema.partial()

export const locationSchema = z.object({
  name: z.string().trim().min(2, 'Location name is required').max(120),
  code: codeSchema,
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(100).nullish(),
  country: z.string().trim().max(100).optional().default('India'),
  pincode: pincodeSchema.nullish(),
  timezone: z.string().trim().max(64).nullish(),
  isActive: z.boolean().optional().default(true),
})

export const updateLocationSchema = locationSchema.partial()

export const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional(),
  includeCounts: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional()
    .default(false),
})

export const settingSchema = z.object({
  category: z.string().trim().min(1).max(60),
  key: z.string().trim().min(1).max(60),
  value: z.unknown(),
  description: z.string().trim().max(300).nullish(),
})

export const settingsUpsertSchema = z.object({
  settings: z.array(settingSchema).min(1, 'At least one setting is required').max(100),
})

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
export type DepartmentInput = z.infer<typeof departmentSchema>
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>
export type EmployeeTypeInput = z.infer<typeof employeeTypeSchema>
export type UpdateEmployeeTypeInput = z.infer<typeof updateEmployeeTypeSchema>
export type DesignationInput = z.infer<typeof designationSchema>
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>
export type LocationInput = z.infer<typeof locationSchema>
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
export type SettingsUpsertInput = z.infer<typeof settingsUpsertSchema>
