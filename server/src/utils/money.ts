/**
 * Deterministic money arithmetic.
 *
 * Every payroll figure is carried through the calculator as an integer number of
 * minor units (paise) so that repeated runs of the same payroll produce byte
 * identical results (plan section 63, rule 14: "Payroll calculations must be
 * reproducible"). Floating point rupees are only used at the API boundary.
 */

export type Minor = number

const MINOR_UNITS_PER_MAJOR = 100

/** Rounds half away from zero, which is the convention used for Indian payroll. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Converts a rupee amount (number or numeric string from pg) into paise. */
export function toMinor(value: number | string | null | undefined): Minor {
  if (value === null || value === undefined || value === '') return 0
  const numeric = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(numeric)) return 0
  return roundHalfUp(numeric * MINOR_UNITS_PER_MAJOR)
}

/** Converts paise back into a rupee number with exactly two decimals. */
export function toMajor(minor: Minor): number {
  return Number((minor / MINOR_UNITS_PER_MAJOR).toFixed(2))
}

/** Formats paise for storage in a NUMERIC(14,2) column. */
export function toNumericString(minor: Minor): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const major = Math.floor(abs / MINOR_UNITS_PER_MAJOR)
  const remainder = abs % MINOR_UNITS_PER_MAJOR
  return `${sign}${major}.${String(remainder).padStart(2, '0')}`
}

export function addMinor(...values: Minor[]): Minor {
  return values.reduce((total, value) => total + value, 0)
}

export function subMinor(a: Minor, b: Minor): Minor {
  return a - b
}

/** Multiplies paise by a plain factor, rounding half up to whole paise. */
export function multiplyMinor(minor: Minor, factor: number): Minor {
  return roundHalfUp(minor * factor)
}

/** Applies a percentage (e.g. 12 for 12%) to a paise amount. */
export function percentOfMinor(minor: Minor, percentage: number): Minor {
  return roundHalfUp((minor * percentage) / 100)
}

/** Pro-rates an amount by paidDays / totalDays, guarding against a zero divisor. */
export function prorateMinor(minor: Minor, paidDays: number, totalDays: number): Minor {
  if (totalDays <= 0) return 0
  return roundHalfUp((minor * paidDays) / totalDays)
}

export function clampMinor(minor: Minor, min: Minor, max: Minor): Minor {
  return Math.min(Math.max(minor, min), max)
}

export function maxMinor(a: Minor, b: Minor): Minor {
  return a > b ? a : b
}

export function minMinor(a: Minor, b: Minor): Minor {
  return a < b ? a : b
}

/** Formats a rupee amount for payslips and exports. */
export function formatCurrency(minor: Minor, currency = 'INR', locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(toMajor(minor))
}
