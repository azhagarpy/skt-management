import bcrypt from 'bcryptjs'
import { env } from '../../config/env.js'

/**
 * Passwords are hashed with bcrypt at a configurable cost. Plain-text passwords
 * are never stored, logged, or returned (plan section 37).
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export interface PasswordStrength {
  valid: boolean
  problems: string[]
}

/**
 * Minimum strength enforced on every password write. Kept here so the rule is
 * applied identically by registration, reset and change-password flows.
 */
export function checkPasswordStrength(password: string): PasswordStrength {
  const problems: string[] = []
  if (password.length < 10) problems.push('Password must be at least 10 characters long')
  if (!/[a-z]/.test(password)) problems.push('Password must contain a lowercase letter')
  if (!/[A-Z]/.test(password)) problems.push('Password must contain an uppercase letter')
  if (!/\d/.test(password)) problems.push('Password must contain a digit')
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Password must contain a symbol')
  return { valid: problems.length === 0, problems }
}
