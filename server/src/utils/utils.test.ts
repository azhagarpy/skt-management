import { describe, expect, it } from 'vitest'
import {
  addMinor,
  multiplyMinor,
  percentOfMinor,
  prorateMinor,
  roundHalfUp,
  toMajor,
  toMinor,
  toNumericString,
} from './money.js'
import {
  addDays,
  countDaysBetween,
  datesBetween,
  datesInMonth,
  daysInMonth,
  isIsoDate,
  isLastWeekdayOccurrence,
  lastDayOfMonth,
  normaliseDate,
  overlapRange,
  weekdayOccurrenceInMonth,
  weekdayOf,
} from './dates.js'
import { maskAadhaar, maskAccountNumber, maskPan } from './mask.js'
import { buildStorageKey, isSafeStorageKey, sanitiseFilename, sniffContentType } from './files.js'

/**
 * Unit tests for the pure helpers payroll correctness and data privacy depend on.
 */

describe('money', () => {
  it('converts rupees to paise without floating point drift', () => {
    // 0.1 + 0.2 style errors are exactly what integer paise exist to avoid.
    expect(toMinor(1234.56)).toBe(123_456)
    expect(toMinor('1234.56')).toBe(123_456)
    expect(toMinor(0.1) + toMinor(0.2)).toBe(toMinor(0.3))
    expect(toMinor(null)).toBe(0)
    expect(toMinor('')).toBe(0)
  })

  it('rounds half away from zero', () => {
    expect(roundHalfUp(0.5)).toBe(1)
    expect(roundHalfUp(1.5)).toBe(2)
    expect(roundHalfUp(-0.5)).toBe(-1)
    expect(roundHalfUp(2.4)).toBe(2)
  })

  it('formats paise for a NUMERIC(14,2) column', () => {
    expect(toNumericString(123_456)).toBe('1234.56')
    expect(toNumericString(5)).toBe('0.05')
    expect(toNumericString(0)).toBe('0.00')
    expect(toNumericString(-2_550)).toBe('-25.50')
  })

  it('round-trips through major units', () => {
    expect(toMajor(toMinor(42_000))).toBe(42_000)
    expect(toMajor(toMinor(39_400.55))).toBe(39_400.55)
  })

  it('prorates safely, including a zero divisor', () => {
    // 42,000 over 30 days, 28 paid.
    expect(toMajor(prorateMinor(toMinor(42_000), 28, 30))).toBe(39_200)
    expect(prorateMinor(toMinor(42_000), 5, 0)).toBe(0)
  })

  it('applies percentages the way payroll expects', () => {
    expect(toMajor(percentOfMinor(toMinor(15_000), 12))).toBe(1_800)
    expect(toMajor(percentOfMinor(toMinor(16_000), 0.75))).toBe(120)
  })

  it('multiplies and adds in whole paise', () => {
    expect(multiplyMinor(toMinor(800), 20.5)).toBe(toMinor(16_400))
    expect(addMinor(toMinor(10), toMinor(20), toMinor(0.05))).toBe(toMinor(30.05))
  })
})

describe('dates', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-09-01')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-9-1')).toBe(false)
    expect(isIsoDate('not-a-date')).toBe(false)
  })

  it('knows how many days a month has, including leap years', () => {
    expect(daysInMonth(2026, 9)).toBe(30)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29')
  })

  it('walks dates without timezone drift', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(datesInMonth(2026, 9)).toHaveLength(30)
    expect(datesBetween('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(countDaysBetween('2026-09-01', '2026-09-30')).toBe(30)
  })

  it('identifies weekdays', () => {
    // 1 September 2026 is a Tuesday.
    expect(weekdayOf('2026-09-01')).toBe('TUESDAY')
    expect(weekdayOf('2026-09-05')).toBe('SATURDAY')
    expect(weekdayOf('2026-09-06')).toBe('SUNDAY')
  })

  it('counts which occurrence of its weekday a date is', () => {
    // Saturdays in September 2026: 5th, 12th, 19th, 26th.
    expect(weekdayOccurrenceInMonth('2026-09-05')).toBe(1)
    expect(weekdayOccurrenceInMonth('2026-09-12')).toBe(2)
    expect(weekdayOccurrenceInMonth('2026-09-19')).toBe(3)
    expect(weekdayOccurrenceInMonth('2026-09-26')).toBe(4)
  })

  it('identifies the last occurrence of a weekday in the month', () => {
    expect(isLastWeekdayOccurrence('2026-09-26')).toBe(true)
    expect(isLastWeekdayOccurrence('2026-09-19')).toBe(false)
  })

  it('normalises whatever the driver returns', () => {
    expect(normaliseDate('2026-09-01T00:00:00.000Z')).toBe('2026-09-01')
    expect(normaliseDate(new Date(Date.UTC(2026, 8, 1)))).toBe('2026-09-01')
    expect(normaliseDate(null)).toBeNull()
  })

  it('computes range overlap', () => {
    expect(overlapRange('2026-09-01', '2026-09-30', '2026-09-15', '2026-10-15')).toEqual({
      from: '2026-09-15',
      to: '2026-09-30',
    })
    expect(overlapRange('2026-09-01', '2026-09-10', '2026-09-11', '2026-09-20')).toBeNull()
  })
})

describe('masking', () => {
  it('never exposes more than the last four digits of an Aadhaar', () => {
    expect(maskAadhaar('234512341234')).toBe('XXXX XXXX 1234')
    expect(maskAadhaar('2345 1234 1234')).toBe('XXXX XXXX 1234')
    expect(maskAadhaar(null)).toBeNull()
  })

  it('masks PAN and account numbers', () => {
    expect(maskPan('ABCDE1234F')).toBe('XXXXXX234F')
    expect(maskAccountNumber('50010000112')).toBe('*******0112')
    expect(maskAccountNumber('12')).toBe('**')
  })

  it('leaves no original digits beyond the visible tail', () => {
    const masked = maskAadhaar('987654321098') ?? ''
    expect(masked.endsWith('1098')).toBe(true)
    expect(masked).not.toContain('9876')
  })
})

describe('file handling', () => {
  it('detects the real content type from magic bytes', () => {
    expect(sniffContentType(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf')
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  })

  it('rejects anything that is not an allowed type, whatever the client claims', () => {
    // A shell script that a client might upload as "application/pdf".
    expect(sniffContentType(Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'))).toBeNull()
    expect(sniffContentType(Buffer.from('<html></html>', 'utf8'))).toBeNull()
    expect(sniffContentType(Buffer.alloc(0))).toBeNull()
  })

  it('strips path components from a client filename', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitiseFilename('C:\\Windows\\System32\\config')).toBe('config')
    expect(sanitiseFilename('')).toBe('file')
    expect(sanitiseFilename('my report (final).pdf')).toBe('my report _final_.pdf')
  })

  it('generates opaque storage keys that never reuse the original name', () => {
    const key = buildStorageKey({
      organizationId: '11111111-1111-1111-1111-111111111111',
      employeeId: '22222222-2222-2222-2222-222222222222',
      category: 'AADHAAR',
      contentType: 'application/pdf',
    })

    expect(key).toContain('11111111-1111-1111-1111-111111111111')
    expect(key.endsWith('.pdf')).toBe(true)
    expect(isSafeStorageKey(key)).toBe(true)

    // Two uploads of the same document never collide.
    const second = buildStorageKey({
      organizationId: '11111111-1111-1111-1111-111111111111',
      employeeId: '22222222-2222-2222-2222-222222222222',
      category: 'AADHAAR',
      contentType: 'application/pdf',
    })
    expect(second).not.toBe(key)
  })

  it('refuses storage keys that try to escape the root', () => {
    expect(isSafeStorageKey('../secrets/key.pem')).toBe(false)
    expect(isSafeStorageKey('/etc/passwd')).toBe(false)
    expect(isSafeStorageKey('org/2026/09/file.pdf')).toBe(true)
  })
})
