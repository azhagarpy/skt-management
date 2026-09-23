import { z } from 'zod'

export const documentCategorySchema = z.enum([
  'PAN',
  'AADHAAR',
  'BANK_PROOF',
  'PF',
  'ESI',
  'PHOTO',
  'RESUME',
  'OFFER_LETTER',
  'EDUCATION',
  'EXPERIENCE',
  'CONTRACT',
  'LEAVE_ATTACHMENT',
  'OTHER',
])

export const verificationStatusSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED'])

/** PAN: five letters, four digits, one letter (plan section 54). */
export const panNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN, for example ABCDE1234F')

export const aadhaarNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s|-/g, ''))
  .refine((value) => /^[0-9]{12}$/.test(value), 'Aadhaar must be 12 digits')
  // The first digit of a real Aadhaar is never 0 or 1.
  .refine((value) => !/^[01]/.test(value), 'Enter a valid Aadhaar number')

export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code, for example HDFC0001234')

export const accountNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6,20}$/, 'Enter a valid account number')

export const uploadDocumentSchema = z.object({
  category: documentCategorySchema.default('OTHER'),
  title: z.string().trim().min(2, 'A document title is required').max(160),
})

export const documentListQuerySchema = z.object({
  category: documentCategorySchema.optional(),
  verificationStatus: verificationStatusSchema.optional(),
})

export const verifyDocumentSchema = z
  .object({
    status: z.enum(['VERIFIED', 'REJECTED']),
    reason: z.string().trim().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'REJECTED' && !value.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required when rejecting' })
    }
  })

export const panSchema = z.object({
  panNumber: panNumberSchema,
  panName: z.string().trim().min(2, 'Name as printed on the PAN is required').max(120),
  documentId: z.string().uuid().nullish(),
})

export const aadhaarSchema = z.object({
  aadhaarNumber: aadhaarNumberSchema,
  aadhaarName: z.string().trim().min(2, 'Name as printed on the Aadhaar is required').max(120),
  documentId: z.string().uuid().nullish(),
})

export const bankAccountSchema = z.object({
  accountHolderName: z.string().trim().min(2, 'Account holder name is required').max(120),
  bankName: z.string().trim().min(2, 'Bank name is required').max(120),
  accountNumber: accountNumberSchema,
  confirmAccountNumber: accountNumberSchema.optional(),
  ifscCode: ifscSchema,
  branchName: z.string().trim().max(120).nullish(),
  accountType: z.enum(['SAVINGS', 'CURRENT', 'OTHER']).default('SAVINGS'),
  isPrimary: z.boolean().default(true),
  documentId: z.string().uuid().nullish(),
}).superRefine((value, ctx) => {
  if (value.confirmAccountNumber && value.confirmAccountNumber !== value.accountNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmAccountNumber'],
      message: 'The account numbers do not match',
    })
  }
})

export const pfSchema = z.object({
  pfApplicable: z.boolean().default(true),
  uanNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{12}$/, 'UAN must be 12 digits')
    .nullish(),
  pfMemberId: z.string().trim().max(40).nullish(),
  /** Name as it appears on PF records - can differ in spelling from the employee's own name. */
  pfName: z.string().trim().max(120).nullish(),
  /** Whether the employee is enrolled in the Pension Scheme (EPS), for statutory reporting. */
  pensionApplicable: z.boolean().default(true),
  employeeContributionPercent: z.coerce.number().min(0).max(100).nullish(),
  employerContributionPercent: z.coerce.number().min(0).max(100).nullish(),
  documentId: z.string().uuid().nullish(),
})

export const esiSchema = z.object({
  esiApplicable: z.boolean().default(false),
  esiNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{10,17}$/, 'Enter a valid ESI number')
    .nullish(),
  /** Name as it appears on ESI records - the ESIC upload format calls this the IP Name. */
  esiName: z
    .string()
    .trim()
    .regex(/^[A-Za-z ]*$/, 'Only alphabets and spaces are allowed')
    .max(120)
    .nullish(),
  employeeContributionPercent: z.coerce.number().min(0).max(100).nullish(),
  employerContributionPercent: z.coerce.number().min(0).max(100).nullish(),
  documentId: z.string().uuid().nullish(),
})

export const verifySectionSchema = z
  .object({
    section: z.enum(['PAN', 'AADHAAR', 'BANK', 'PF', 'ESI']),
    status: z.enum(['VERIFIED', 'REJECTED']),
    reason: z.string().trim().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'REJECTED' && !value.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required when rejecting' })
    }
  })

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>
export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>
export type PanInput = z.infer<typeof panSchema>
export type AadhaarInput = z.infer<typeof aadhaarSchema>
export type BankAccountInput = z.infer<typeof bankAccountSchema>
export type PfInput = z.infer<typeof pfSchema>
export type EsiInput = z.infer<typeof esiSchema>
export type VerifySectionInput = z.infer<typeof verifySectionSchema>
