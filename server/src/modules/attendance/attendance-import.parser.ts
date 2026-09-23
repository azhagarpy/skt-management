import ExcelJS from 'exceljs'
import { ApiError } from '../../utils/api-error.js'
import { addDays, isIsoDate, todayIso, type IsoDate } from '../../utils/dates.js'

/**
 * Reads the .xlsx exports of the entrance Face ID system.
 *
 * Only what attendance needs is taken from a sheet: who (Person Id), which day,
 * and whether they were in. Punch times, shifts, work orders and totals are
 * ignored - payroll works from statuses, not hours (see attendance.validation).
 *
 * Two layouts are understood, detected from the header row:
 *  - MUSTER        one row per person, one column per day holding P / A / HF / WO.
 *  - DAILY_PRESENT one row per person present, dated by the punch-in date.
 *                  People who did not punch in are simply absent from the sheet.
 */

export type ImportStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY_LEAVE' | 'WEEKLY_OFF' | 'HOLIDAY'
export type SheetFormat = 'MUSTER' | 'DAILY_PRESENT'

export interface ParsedEntry {
  personId: string
  personName: string
  date: IsoDate
  status: ImportStatus
}

export interface UnrecognisedCode {
  personId: string
  date: IsoDate
  code: string
}

export interface ParsedSheet {
  format: SheetFormat
  /** Every distinct date found in the sheet, ascending. */
  dates: IsoDate[]
  /** Distinct people in the sheet. */
  people: number
  entries: ParsedEntry[]
  unrecognised: UnrecognisedCode[]
  /** Person/date pairs that appeared more than once (the last value wins). */
  duplicates: number
}

export interface ParseOptions {
  fileName?: string
  /** Year of the LAST date column of a muster whose headers carry no year. */
  year?: number
}

/** Muster cell codes -> status. Anything else is reported back, never guessed. */
const MUSTER_CODES: Record<string, ImportStatus> = {
  P: 'PRESENT',
  A: 'ABSENT',
  HF: 'HALF_DAY_LEAVE',
  HD: 'HALF_DAY_LEAVE',
  WO: 'WEEKLY_OFF',
  H: 'HOLIDAY',
  PH: 'HOLIDAY',
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const HEADER_SCAN_ROWS = 10

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Flattens any exceljs cell value (rich text, formula, hyperlink, date) to trimmed text. */
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim()
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('text' in value) return String(value.text).trim()
    return ''
  }
  return String(value).trim()
}

function normaliseHeader(value: ExcelJS.CellValue | undefined): string {
  return cellText(value).toLowerCase().replace(/\s+/g, ' ')
}

/** Spreadsheet date cells arrive as UTC-midnight Dates, so read the UTC parts. */
function isoFromDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10)
}

function buildIso(year: number, month: number, day: number): IsoDate | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isIsoDate(iso) ? iso : null
}

/** Full date cells: "17/09/2026", "17-09-2026", "2026-09-17", or a real date cell. */
function parseFullDate(value: ExcelJS.CellValue | undefined): IsoDate | null {
  if (value instanceof Date) return isoFromDate(value)
  const text = cellText(value)
  if (!text) return null

  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text)
  if (dayFirst) return buildIso(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]))

  const yearFirst = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (yearFirst) return buildIso(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]))

  return null
}

interface DayMonth {
  day: number
  month: number
  /** Present only when the header spelled the year out. */
  year: number | null
}

/** Muster headers: "21-Jul", "1-Aug", "21-Jul-2026", "21-Jul-26", or a real date cell. */
function parseDayMonthHeader(value: ExcelJS.CellValue | undefined): DayMonth | null {
  if (value instanceof Date) {
    const iso = isoFromDate(value)
    return { day: Number(iso.slice(8, 10)), month: Number(iso.slice(5, 7)), year: Number(iso.slice(0, 4)) }
  }
  const match = /^(\d{1,2})[\s-]([A-Za-z]{3,9})(?:[\s-](\d{2}|\d{4}))?$/.exec(cellText(value))
  if (!match) return null
  const month = MONTHS.indexOf((match[2] as string).slice(0, 3).toLowerCase()) + 1
  if (month === 0) return null
  const rawYear = match[3] ? Number(match[3]) : null
  return {
    day: Number(match[1]),
    month,
    year: rawYear === null ? null : rawYear < 100 ? 2000 + rawYear : rawYear,
  }
}

// ---------------------------------------------------------------------------
// Year resolution for muster headers
// ---------------------------------------------------------------------------

/**
 * Muster columns carry "21-Jul" with no year, but they are consecutive days, so
 * one anchor year for the last column is enough: walking left, the year drops by
 * one each time the month number jumps up (Jan -> Dec).
 *
 * The anchor is, in order: the explicit `year` option, a year written in the file
 * name ("Muster Report Aug-2026"), or the most recent year in which the last
 * column is not in the future.
 */
function anchorYear(last: DayMonth, options: ParseOptions): number {
  if (options.year) return options.year

  const inName = options.fileName?.match(/(?:19|20)\d{2}/g)
  if (inName) return Number(inName[inName.length - 1])

  const today = todayIso()
  const currentYear = Number(today.slice(0, 4))
  const candidate = buildIso(currentYear, last.month, last.day)
  // A cycle ending "20-Jan" read in December belongs to next year, a few weeks ahead.
  if (candidate && candidate > addDays(today, 45)) return currentYear - 1
  return currentYear
}

function resolveHeaderDates(columns: { col: number; dm: DayMonth }[], options: ParseOptions): Map<number, IsoDate> {
  const resolved = new Map<number, IsoDate>()
  const last = columns[columns.length - 1]
  if (!last) return resolved

  let year = last.dm.year ?? anchorYear(last.dm, options)
  let nextMonth = last.dm.month

  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const { col, dm } = columns[index] as { col: number; dm: DayMonth }
    if (dm.year !== null) {
      year = dm.year
    } else if (dm.month > nextMonth) {
      year -= 1
    }
    nextMonth = dm.month

    const iso = buildIso(year, dm.month, dm.day)
    if (!iso) {
      throw ApiError.badRequest(`The date column "${dm.day}/${dm.month}" is not a valid date`)
    }
    resolved.set(col, iso)
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Layout parsers
// ---------------------------------------------------------------------------

interface Header {
  row: number
  columns: Map<string, number>
}

/** Finds the row holding "Person Id", and maps every header label to its column. */
function findHeader(sheet: ExcelJS.Worksheet): Header | null {
  const limit = Math.min(sheet.rowCount, HEADER_SCAN_ROWS)
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const columns = new Map<string, number>()
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, col) => {
      const label = normaliseHeader(cell.value)
      if (label && !columns.has(label)) columns.set(label, col)
    })
    if (columns.has('person id')) return { row: rowNumber, columns }
  }
  return null
}

function normalisePersonId(value: ExcelJS.CellValue | undefined): string {
  return cellText(value).toUpperCase()
}

function parseMuster(sheet: ExcelJS.Worksheet, header: Header, options: ParseOptions): ParsedSheet | null {
  const idCol = header.columns.get('person id') as number
  const nameCol = header.columns.get('person name')

  const dateColumns: { col: number; dm: DayMonth }[] = []
  sheet.getRow(header.row).eachCell({ includeEmpty: false }, (cell, col) => {
    if (col === idCol || col === nameCol) return
    const dm = parseDayMonthHeader(cell.value)
    if (dm) dateColumns.push({ col, dm })
  })
  // A muster is a run of day columns; without any it is some other layout.
  if (dateColumns.length === 0) return null

  const dateByColumn = resolveHeaderDates(dateColumns, options)
  const byKey = new Map<string, ParsedEntry>()
  const unrecognised: UnrecognisedCode[] = []
  const people = new Set<string>()
  let duplicates = 0

  for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const personId = normalisePersonId(row.getCell(idCol).value)
    if (!personId) continue
    people.add(personId)
    const personName = nameCol ? cellText(row.getCell(nameCol).value).replace(/\s+/g, ' ') : ''

    for (const { col } of dateColumns) {
      const code = cellText(row.getCell(col).value).toUpperCase()
      if (!code) continue // a blank day means "no information", not absent
      const date = dateByColumn.get(col) as IsoDate
      const status = MUSTER_CODES[code]
      if (!status) {
        unrecognised.push({ personId, date, code })
        continue
      }
      const key = `${personId}|${date}`
      if (byKey.has(key)) duplicates += 1
      byKey.set(key, { personId, personName, date, status })
    }
  }

  return finish('MUSTER', byKey, unrecognised, people, duplicates)
}

/** The day a Daily Present row belongs to: the punch-in date, else the nearest thing to it. */
const DAILY_DATE_HEADERS = ['in punch date', 'schedule date', 'out punch date', 'regularized in date']

function parseDailyPresent(sheet: ExcelJS.Worksheet, header: Header): ParsedSheet | null {
  const dateCols = DAILY_DATE_HEADERS.map((label) => header.columns.get(label)).filter(
    (col): col is number => col !== undefined,
  )
  if (dateCols.length === 0) return null

  const idCol = header.columns.get('person id') as number
  const nameCol = header.columns.get('person name')
  const byKey = new Map<string, ParsedEntry>()
  const people = new Set<string>()
  let duplicates = 0

  for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const personId = normalisePersonId(row.getCell(idCol).value)
    if (!personId) continue

    let date: IsoDate | null = null
    for (const col of dateCols) {
      date = parseFullDate(row.getCell(col).value)
      if (date) break
    }
    if (!date) continue

    people.add(personId)
    const key = `${personId}|${date}`
    if (byKey.has(key)) duplicates += 1
    byKey.set(key, {
      personId,
      personName: nameCol ? cellText(row.getCell(nameCol).value).replace(/\s+/g, ' ') : '',
      date,
      status: 'PRESENT',
    })
  }

  return finish('DAILY_PRESENT', byKey, [], people, duplicates)
}

function finish(
  format: SheetFormat,
  byKey: Map<string, ParsedEntry>,
  unrecognised: UnrecognisedCode[],
  people: Set<string>,
  duplicates: number,
): ParsedSheet {
  const entries = [...byKey.values()]
  const dates = [...new Set([...entries.map((entry) => entry.date), ...unrecognised.map((item) => item.date)])].sort()
  return { format, dates, people: people.size, entries, unrecognised, duplicates }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** .xlsx files are zip archives; anything else is refused before exceljs sees it. */
function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
}

export async function parseAttendanceSheet(buffer: Buffer, options: ParseOptions = {}): Promise<ParsedSheet> {
  if (!looksLikeXlsx(buffer)) {
    throw ApiError.badRequest('The file is not a valid .xlsx workbook')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  } catch {
    throw ApiError.badRequest('The workbook could not be read. Export it from the Face ID system again.')
  }

  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet)
    if (!header) continue
    const parsed = parseMuster(sheet, header, options) ?? parseDailyPresent(sheet, header)
    if (parsed) {
      if (parsed.entries.length === 0 && parsed.unrecognised.length === 0) {
        throw ApiError.badRequest('The sheet has no attendance rows')
      }
      return parsed
    }
  }

  throw ApiError.badRequest(
    'This is not a recognised Face ID report. Expected a Muster Report (a "Person Id" column plus one column per date) or a Daily Present Report.',
  )
}
