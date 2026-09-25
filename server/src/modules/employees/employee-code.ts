/**
 * Suggesting the next employee code.
 *
 * Codes here look like SENT0007 / SENT0580: a text prefix and a zero-padded
 * number. The next one is the highest number already used plus one, keeping the
 * prefix and the width, so a new employee lands at SENT0581 rather than SENT581.
 *
 * Purely a suggestion. It is prefilled into the form and can be typed over, and
 * the unique constraint on (organization_id, employee_code) is what actually
 * stops a collision - two people opening the form at once would otherwise both
 * be offered the same code.
 */

export interface ParsedCode {
  prefix: string
  digits: string
  value: number
}

/** Splits a code into its prefix and trailing number, or null if it has none. */
export function parseCode(code: string): ParsedCode | null {
  const match = /^(.*?)(\d+)\s*$/.exec(code.trim())
  if (!match) return null
  const [, prefix = '', digits = ''] = match
  if (digits.length === 0) return null
  return { prefix, digits, value: Number(digits) }
}

/**
 * The code to offer next, given every code already in use.
 *
 * The most common prefix wins when several are in use, so a handful of oddly
 * coded historical rows do not drag the suggestion away from the house style.
 */
export function nextEmployeeCode(existing: string[], fallbackPrefix = 'EMP', fallbackWidth = 4): string {
  const parsed = existing.map(parseCode).filter((entry): entry is ParsedCode => entry !== null)

  if (parsed.length === 0) {
    return `${fallbackPrefix}${'1'.padStart(fallbackWidth, '0')}`
  }

  const counts = new Map<string, number>()
  for (const entry of parsed) counts.set(entry.prefix, (counts.get(entry.prefix) ?? 0) + 1)

  let prefix = ''
  let best = -1
  for (const [candidate, count] of counts) {
    // Ties go to the longer prefix: it is the more specific of the two.
    if (count > best || (count === best && candidate.length > prefix.length)) {
      prefix = candidate
      best = count
    }
  }

  const samePrefix = parsed.filter((entry) => entry.prefix === prefix)
  const highest = samePrefix.reduce((max, entry) => (entry.value > max ? entry.value : max), 0)
  // Pad to the widest number seen on that prefix, so SENT0099 is followed by
  // SENT0100 rather than SENT100.
  const width = samePrefix.reduce((max, entry) => (entry.digits.length > max ? entry.digits.length : max), 0)

  return `${prefix}${String(highest + 1).padStart(width, '0')}`
}
