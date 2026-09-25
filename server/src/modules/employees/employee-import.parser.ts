/**
 * Reading a bulk employee upload.
 *
 * The accepted layout is the Employee Master export, so a sheet exported from
 * Reports can be edited and uploaded back without rearranging anything. Header
 * matching is case- and space-insensitive, and unknown columns are ignored, so
 * a file with extra notes columns still loads.
 *
 * This module only reads and shape-checks. Anything needing the database -
 * whether a department exists, whether a code is already taken - belongs to
 * employee-import.service.ts, which keeps the row rules testable without one.
 */
import ExcelJS from 'exceljs'
import { ApiError } from '../../utils/api-error.js'

/** Header label -> field, as the Employee Master export writes them. */
const COLUMN_ALIASES: Record<string, string> = {
  'employee id': 'employeeCode',
  'employee code': 'employeeCode',
  name: 'name',
  'employee name': 'name',
  department: 'departmentName',
  section: 'designationName',
  designation: 'designationName',
  'supply type': 'employeeTypeName',
  'employee type': 'employeeTypeName',
  supervisor: 'supervisorName',
  'employment type': 'employmentType',
  status: 'employmentStatus',
  'employment status': 'employmentStatus',
  'salary basis': 'salaryBasis',
  'joining date': 'joiningDate',
  'exit date': 'exitDate',
  'work email': 'workEmail',
  email: 'workEmail',
  mobile: 'mobileNumber',
  'mobile number': 'mobileNumber',
  phone: 'mobileNumber',
}

export interface ParsedEmployeeRow {
  /** 1-based row number in the sheet, for pointing at a bad row. */
  rowNumber: number
  employeeCode: string
  name: string
  departmentName: string | null
  designationName: string | null
  employeeTypeName: string | null
  supervisorName: string | null
  employmentType: string | null
  employmentStatus: string | null
  salaryBasis: string | null
  joiningDate: string | null
  exitDate: string | null
  workEmail: string | null
  mobileNumber: string | null
}

export interface ParsedEmployeeSheet {
  rows: ParsedEmployeeRow[]
  /** Headers present in the file that nothing maps to. */
  ignoredColumns: string[]
}

function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

const text = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return toIsoDate(value)
  if (typeof value === 'object') {
    // ExcelJS hands back { text } for hyperlinks and { result } for formulas.
    const cell = value as { text?: unknown; result?: unknown }
    if (cell.text !== undefined) return text(cell.text)
    if (cell.result !== undefined) return text(cell.result)
  }
  return String(value).replace(/ /g, ' ').trim()
}

const blank = (value: string): string | null => (value === '' ? null : value)

function toIsoDate(date: Date): string {
  // Spreadsheet dates arrive at UTC midnight; formatting in UTC avoids shifting
  // a joining date back a day in timezones behind it.
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/**
 * Accepts what a spreadsheet actually produces: a real date cell, or text in
 * ISO, d/m/y or d-m-y. Ambiguous US-style m/d/y is not guessed at - a value
 * that cannot be read is reported rather than silently misread, because a wrong
 * joining date changes service length and leave.
 */
export function parseSheetDate(value: unknown): string | null {
  if (value instanceof Date) return toIsoDate(value)
  const raw = text(value)
  if (raw === '') return null

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  if (iso) {
    const [, y = '', m = '', d = ''] = iso
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw)
  if (dmy) {
    const [, d = '', m = '', y = ''] = dmy
    if (Number(m) > 12) return null
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  return null
}

function headerRow(sheet: ExcelJS.Worksheet): { rowNumber: number; columns: Map<number, string> } | null {
  const limit = Math.min(sheet.rowCount, 20)
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const columns = new Map<number, string>()
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const label = text(cell.value).toLowerCase().replace(/\s+/g, ' ')
      const field = COLUMN_ALIASES[label]
      if (field) columns.set(columnNumber, field)
    })
    // The two columns nothing can be built without.
    const fields = new Set(columns.values())
    if (fields.has('employeeCode') && fields.has('name')) return { rowNumber, columns }
  }
  return null
}

export async function parseEmployeeSheet(buffer: Buffer): Promise<ParsedEmployeeSheet> {
  if (!looksLikeXlsx(buffer)) {
    throw ApiError.badRequest('The file is not a valid .xlsx workbook. Export the Employee Master report and upload that.')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  } catch {
    throw ApiError.badRequest('The workbook could not be read')
  }

  for (const sheet of workbook.worksheets) {
    const header = headerRow(sheet)
    if (!header) continue

    const ignored: string[] = []
    sheet.getRow(header.rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (!header.columns.has(columnNumber)) {
        const label = text(cell.value)
        if (label !== '') ignored.push(label)
      }
    })

    const rows: ParsedEmployeeRow[] = []
    for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber)
      const values: Record<string, string> = {}
      let hasAnything = false
      for (const [columnNumber, field] of header.columns) {
        const cell = row.getCell(columnNumber)
        const value = field === 'joiningDate' || field === 'exitDate'
          ? parseSheetDate(cell.value) ?? text(cell.value)
          : text(cell.value)
        values[field] = value
        if (value !== '') hasAnything = true
      }
      // Blank spacer rows are skipped rather than reported as errors.
      if (!hasAnything) continue

      rows.push({
        rowNumber,
        employeeCode: values.employeeCode ?? '',
        name: values.name ?? '',
        departmentName: blank(values.departmentName ?? ''),
        designationName: blank(values.designationName ?? ''),
        employeeTypeName: blank(values.employeeTypeName ?? ''),
        supervisorName: blank(values.supervisorName ?? ''),
        employmentType: blank(values.employmentType ?? ''),
        employmentStatus: blank(values.employmentStatus ?? ''),
        salaryBasis: blank(values.salaryBasis ?? ''),
        joiningDate: blank(values.joiningDate ?? ''),
        exitDate: blank(values.exitDate ?? ''),
        workEmail: blank(values.workEmail ?? ''),
        mobileNumber: blank(values.mobileNumber ?? ''),
      })
    }

    if (rows.length === 0) throw ApiError.badRequest('The sheet has a header but no employee rows')
    return { rows, ignoredColumns: ignored }
  }

  throw ApiError.badRequest(
    'No employee rows were found. The sheet needs at least an "Employee ID" and a "Name" column, as the Employee Master export writes them.',
  )
}

export interface RowProblem {
  rowNumber: number
  employeeCode: string
  message: string
}

/**
 * The checks that need nothing but the file itself.
 *
 * Duplicates within the upload are caught here; duplicates against employees
 * already saved need the database and are checked in the service.
 */
export function validateParsedRows(rows: ParsedEmployeeRow[]): RowProblem[] {
  const problems: RowProblem[] = []
  const seen = new Map<string, number>()

  for (const row of rows) {
    const code = row.employeeCode.trim().toUpperCase()

    if (code === '') {
      problems.push({ rowNumber: row.rowNumber, employeeCode: '', message: 'Employee ID is blank' })
      continue
    }
    if (row.name.trim() === '') {
      problems.push({ rowNumber: row.rowNumber, employeeCode: row.employeeCode, message: 'Name is blank' })
    }

    const firstSeen = seen.get(code)
    if (firstSeen !== undefined) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: row.employeeCode,
        message: `Employee ID ${row.employeeCode} is already used on row ${firstSeen} of this file`,
      })
    } else {
      seen.set(code, row.rowNumber)
    }

    if (row.joiningDate === null) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: row.employeeCode,
        message: 'Joining date is missing',
      })
    } else if (parseSheetDate(row.joiningDate) === null) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: row.employeeCode,
        message: `Joining date "${row.joiningDate}" is not a date the importer can read. Use YYYY-MM-DD or DD/MM/YYYY.`,
      })
    }

    if (row.exitDate !== null && parseSheetDate(row.exitDate) === null) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: row.employeeCode,
        message: `Exit date "${row.exitDate}" is not a date the importer can read`,
      })
    }
  }

  return problems
}
