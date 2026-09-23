import { z } from 'zod'
import { Check, X } from 'lucide-react'

/**
 * Password rules, mirrored from the API so the user sees the same requirements
 * the server enforces. The server remains the authority (plan section 54).
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters long')
  .max(128, 'Password must be at most 128 characters long')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')

const RULES: { label: string; test: (value: string) => boolean }[] = [
  { label: 'At least 10 characters', test: (value) => value.length >= 10 },
  { label: 'A lowercase letter', test: (value) => /[a-z]/.test(value) },
  { label: 'An uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { label: 'A digit', test: (value) => /\d/.test(value) },
  { label: 'A symbol', test: (value) => /[^A-Za-z0-9]/.test(value) },
]

export function PasswordStrengthHint({ password }: { password: string }) {
  if (!password) return null

  return (
    <ul className="password-rules" aria-label="Password requirements">
      {RULES.map((rule) => {
        const passed = rule.test(password)
        return (
          <li key={rule.label} className={passed ? 'rule-passed' : 'rule-pending'}>
            {passed ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            <span>{rule.label}</span>
          </li>
        )
      })}
    </ul>
  )
}
