import { z } from 'zod'

export const emailSchema = z.string().trim().toLowerCase().email('A valid email address is required').max(254)

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters long')
  .max(128, 'Password must be at most 128 characters long')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')

/** Login accepts either an email address or an employee code (plan section 37). */
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or employee ID is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
  rememberMe: z.boolean().optional().default(false),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(512).optional(),
})

export const forgotPasswordSchema = z.object({
  email: emailSchema,
})

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(512),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
})

export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
