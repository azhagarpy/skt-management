/**
 * Masking helpers for sensitive identity/financial data (plan sections 14, 15, 53).
 * The unmasked value is only ever returned by endpoints that check an explicit
 * "view sensitive data" permission.
 */

export function maskAadhaar(value: string | null | undefined): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return 'XXXX XXXX XXXX'
  return `XXXX XXXX ${digits.slice(-4)}`
}

export function maskPan(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toUpperCase()
  if (trimmed.length < 4) return 'XXXXXXXXXX'
  return `${'X'.repeat(Math.max(trimmed.length - 4, 0))}${trimmed.slice(-4)}`
}

export function maskAccountNumber(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`
}

export function maskGeneric(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length <= visible) return '*'.repeat(trimmed.length)
  return `${'*'.repeat(trimmed.length - visible)}${trimmed.slice(-visible)}`
}
