/** Display formatting helpers, kept in one place so the app is consistent. */

const currencyFormatters = new Map<string, Intl.NumberFormat>()

export function formatCurrency(value: number | null | undefined, currency = 'INR', locale = 'en-IN'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const key = `${locale}:${currency}`
  let formatter = currencyFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    currencyFormatters.set(key, formatter)
  }
  return formatter.format(value)
}

/** Compact currency for dashboard tiles: 52,00,000 becomes ₹52.0L. */
export function formatCurrencyCompact(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const symbol = currency === 'INR' ? '₹' : ''
  const absolute = Math.abs(value)
  const sign = value < 0 ? '-' : ''

  if (currency === 'INR') {
    if (absolute >= 10_000_000) return `${sign}${symbol}${(absolute / 10_000_000).toFixed(2)}Cr`
    if (absolute >= 100_000) return `${sign}${symbol}${(absolute / 100_000).toFixed(2)}L`
    if (absolute >= 1_000) return `${sign}${symbol}${(absolute / 1_000).toFixed(1)}K`
  }
  return formatCurrency(value, currency)
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(
    value,
  )
}

/** Day counts show a decimal only when there is a half day to show. */
export function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function formatDate(value: string | Date | null | undefined, locale = 'en-IN'): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : value
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  )
}

export function formatDateTime(value: string | Date | null | undefined, locale = 'en-IN'): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'

  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const thresholds: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [604_800, 'day'],
    [2_629_800, 'week'],
    [31_557_600, 'month'],
  ]

  const absolute = Math.abs(seconds)
  if (absolute < 60) return formatter.format(seconds, 'second')
  for (const [limit, unit] of thresholds) {
    if (absolute < limit) {
      const divisor = unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : unit === 'day' ? 86_400 : unit === 'week' ? 604_800 : 2_629_800
      return formatter.format(Math.round(seconds / divisor), unit)
    }
  }
  return formatter.format(Math.round(seconds / 31_557_600), 'year')
}

export function formatMonth(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}

/** Turns SCREAMING_SNAKE enum values into readable labels. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—'
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    // Stored codes such as DESIGNATION_CREATED predate the rename to "Section".
    .replace(/\bDesignation\b/g, 'Section')
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase()
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase()
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `YYYY-MM-DD` for today, in the user's local calendar. */
export function todayIso(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function firstOfMonthIso(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function lastOfMonthIso(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
