import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination.js'
import { isIsoDate } from '../../utils/dates.js'
import { codeSchema, phoneSchema, pincodeSchema } from '../organization/organization.validation.js'

export const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Enter a valid date in YYYY-MM-DD format')

export const genderSchema = z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'])
export const maritalStatusSchema = z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED'])
export const employmentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN'])
export const employmentStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'RESIGNED', 'TERMINATED'])
export const salaryBasisSchema = z.enum(['MONTHLY', 'DAILY'])
export const roleSchema = z.enum(['SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE'])
/** The supply type is a managed row now, so the form sends its id. */
export const employeeTypeIdSchema = z.string().uuid()
export const plantSchema = z.enum(['ULTRATECH', 'ICL'])
/** Skill classification printed on the statutory Letter of Appointment. */
export const skillCategorySchema = z.enum(['UNSKILLED', 'SEMI_SKILLED', 'SKILLED', 'HIGHLY_SKILLED'])
/** Rupees per overtime hour, overriding the org's default PSR rate for this employee. */
export const overtimeRateOverrideSchema = z.coerce.number().min(0).max(99_999_999)

const addressSchema = z.object({
  addressType: z.enum(['CURRENT', 'PERMANENT']).default('CURRENT'),
  addressLine1: z.string().trim().min(3, 'Address line 1 is required').max(200),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2, 'City is required').max(100),
  state: z.string().trim().min(2, 'State is required').max(100),
  country: z.string().trim().max(100).default('India'),
  pincode: pincodeSchema,
})

const emergencyContactSchema = z.object({
  name: z.string().trim().min(2, 'Contact name is required').max(120),
  relationship: z.string().trim().min(2, 'Relationship is required').max(60),
  phone: phoneSchema,
  alternatePhone: phoneSchema.nullish(),
  address: z.string().trim().max(300).nullish(),
  isPrimary: z.boolean().default(true),
})

export const createEmployeeSchema = z
  .object({
    employeeCode: codeSchema,
    firstName: z.string().trim().min(1, 'First name is required').max(80),
    middleName: z.string().trim().max(80).nullish(),
    lastName: z.string().trim().max(80).nullish(),
    gender: genderSchema.default('UNDISCLOSED'),
    dateOfBirth: isoDateSchema.nullish(),
    maritalStatus: maritalStatusSchema.default('UNDISCLOSED'),
    bloodGroup: z.string().trim().max(8).nullish(),
    parentName: z.string().trim().max(160).nullish(),
    personalEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    workEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    mobileNumber: phoneSchema.nullish(),
    alternateNumber: phoneSchema.nullish(),

    departmentId: z.string().uuid().nullish(),
    designationId: z.string().uuid().nullish(),
    locationId: z.string().uuid().nullish(),
    supervisorId: z.string().uuid().nullish(),

    isSupervisor: z.boolean().default(false),
    employmentType: employmentTypeSchema.default('FULL_TIME'),
    employmentStatus: employmentStatusSchema.default('ACTIVE'),
    salaryBasis: salaryBasisSchema.default('MONTHLY'),
    employeeTypeId: employeeTypeIdSchema,
    plant: plantSchema.nullish(),
    skillCategory: skillCategorySchema.nullish(),
    duties: z.string().trim().max(1000).nullish(),
    overtimeRateOverride: overtimeRateOverrideSchema.nullish(),

    joiningDate: isoDateSchema,
    confirmationDate: isoDateSchema.nullish(),

    address: addressSchema.nullish(),
    emergencyContact: emergencyContactSchema.nullish(),

    /** When present, a login is created alongside the employee record. */
    createUserAccount: z.boolean().default(false),
    userEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    userRole: roleSchema.default('EMPLOYEE'),
    temporaryPassword: z.string().min(10).max(128).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.createUserAccount && !value.userEmail && !value.workEmail && !value.personalEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userEmail'],
        message: 'An email address is required to create a login',
      })
    }
    if (value.dateOfBirth && value.dateOfBirth >= value.joiningDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateOfBirth'],
        message: 'Date of birth must be before the joining date',
      })
    }
    if (value.confirmationDate && value.confirmationDate < value.joiningDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationDate'],
        message: 'Confirmation date cannot be before the joining date',
      })
    }
  })

/** Fields an administrator may change. */
export const updateEmployeeSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  middleName: z.string().trim().max(80).nullish(),
  lastName: z.string().trim().max(80).nullish(),
  gender: genderSchema.optional(),
  dateOfBirth: isoDateSchema.nullish(),
  maritalStatus: maritalStatusSchema.optional(),
  bloodGroup: z.string().trim().max(8).nullish(),
  parentName: z.string().trim().max(160).nullish(),
  personalEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  workEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  mobileNumber: phoneSchema.nullish(),
  alternateNumber: phoneSchema.nullish(),
  departmentId: z.string().uuid().nullish(),
  designationId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  supervisorId: z.string().uuid().nullish(),
  isSupervisor: z.boolean().optional(),
  employmentType: employmentTypeSchema.optional(),
  employmentStatus: employmentStatusSchema.optional(),
  salaryBasis: salaryBasisSchema.optional(),
  employeeTypeId: employeeTypeIdSchema.optional(),
  plant: plantSchema.nullish(),
  skillCategory: skillCategorySchema.nullish(),
  duties: z.string().trim().max(1000).nullish(),
  overtimeRateOverride: overtimeRateOverrideSchema.nullish(),
  joiningDate: isoDateSchema.optional(),
  confirmationDate: isoDateSchema.nullish(),
  noticeStartDate: isoDateSchema.nullish(),
  exitDate: isoDateSchema.nullish(),
  exitReason: z.string().trim().max(500).nullish(),
  changeReason: z.string().trim().max(300).optional(),
})

/**
 * The narrower set an employee may change on their own profile
 * (plan section 3: "Update allowed personal information").
 */
export const updateOwnProfileSchema = z.object({
  personalEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  mobileNumber: phoneSchema.nullish(),
  alternateNumber: phoneSchema.nullish(),
  maritalStatus: maritalStatusSchema.optional(),
  bloodGroup: z.string().trim().max(8).nullish(),
  address: addressSchema.optional(),
  emergencyContact: emergencyContactSchema.optional(),
})

export const employeeListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(160).optional(),
  departmentId: z.string().uuid().optional(),
  designationId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  supervisorId: z.string().uuid().optional(),
  employmentStatus: employmentStatusSchema.optional(),
  employmentType: employmentTypeSchema.optional(),
  salaryBasis: salaryBasisSchema.optional(),
  employeeTypeId: employeeTypeIdSchema.optional(),
  plant: plantSchema.optional(),
  isSupervisor: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional(),
  joinedFrom: isoDateSchema.optional(),
  joinedTo: isoDateSchema.optional(),
})

export const addressUpsertSchema = addressSchema
export const emergencyContactUpsertSchema = emergencyContactSchema

export const jobHistorySchema = z.object({
  changeType: z.enum([
    'JOINED',
    'PROMOTION',
    'TRANSFER',
    'DEPARTMENT_CHANGE',
    'DESIGNATION_CHANGE',
    'SUPERVISOR_CHANGE',
    'LOCATION_CHANGE',
    'STATUS_CHANGE',
    'EMPLOYMENT_TYPE_CHANGE',
    'EMPLOYEE_TYPE_CHANGE',
    'PLANT_CHANGE',
    'EXIT',
  ]),
  effectiveFrom: isoDateSchema,
  departmentId: z.string().uuid().nullish(),
  designationId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  supervisorId: z.string().uuid().nullish(),
  employmentType: employmentTypeSchema.nullish(),
  employmentStatus: employmentStatusSchema.nullish(),
  notes: z.string().trim().max(500).nullish(),
})

export const employeeIdParam = z.object({
  id: z.union([z.literal('me'), z.string().uuid('A valid employee id is required')]),
})

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>
export type AddressInput = z.infer<typeof addressUpsertSchema>
export type EmergencyContactInput = z.infer<typeof emergencyContactUpsertSchema>
export type JobHistoryInput = z.infer<typeof jobHistorySchema>
