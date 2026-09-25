import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { nextEmployeeCode, parseCode } from './employee-code.js'
import { parseEmployeeSheet, parseSheetDate, validateParsedRows, type ParsedEmployeeRow } from './employee-import.parser.js'

// ---------------------------------------------------------------------------
// Next employee code
// ---------------------------------------------------------------------------

describe('parseCode', () => {
  it('splits a prefix from its trailing number', () => {
    expect(parseCode('SENT0007')).toEqual({ prefix: 'SENT', digits: '0007', value: 7 })
  })

  it('handles a code that is only digits', () => {
    expect(parseCode('42')).toEqual({ prefix: '', digits: '42', value: 42 })
  })

  it('returns null when there is no number to continue from', () => {
    expect(parseCode('SENT')).toBeNull()
    expect(parseCode('')).toBeNull()
  })
})

describe('nextEmployeeCode', () => {
  it('continues from the highest number in use', () => {
    expect(nextEmployeeCode(['SENT0007', 'SENT0580', 'SENT0021'])).toBe('SENT0581')
  })

  it('keeps the zero padding', () => {
    expect(nextEmployeeCode(['SENT0099'])).toBe('SENT0100')
  })

  it('widens when the number outgrows the padding', () => {
    expect(nextEmployeeCode(['SENT9999'])).toBe('SENT10000')
  })

  it('starts a fresh organization at one', () => {
    expect(nextEmployeeCode([])).toBe('EMP0001')
  })

  it('ignores codes with no number rather than failing', () => {
    expect(nextEmployeeCode(['TEMP', 'SENT0004'])).toBe('SENT0005')
  })

  it('follows the most common prefix, not a stray one', () => {
    // One legacy OLD9999 must not drag the suggestion away from the house style.
    expect(nextEmployeeCode(['SENT0001', 'SENT0002', 'SENT0003', 'OLD9999'])).toBe('SENT0004')
  })

  it('is not confused by the order it is given', () => {
    expect(nextEmployeeCode(['SENT0580', 'SENT0007'])).toBe(nextEmployeeCode(['SENT0007', 'SENT0580']))
  })
})

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe('parseSheetDate', () => {
  it('reads a real date cell', () => {
    expect(parseSheetDate(new Date(Date.UTC(2026, 3, 14)))).toBe('2026-04-14')
  })

  it('reads ISO and pads single digits', () => {
    expect(parseSheetDate('2026-4-7')).toBe('2026-04-07')
  })

  it('reads day-first text', () => {
    expect(parseSheetDate('14/04/2026')).toBe('2026-04-14')
    expect(parseSheetDate('14-04-2026')).toBe('2026-04-14')
  })

  it('refuses a month over twelve rather than guessing US order', () => {
    expect(parseSheetDate('04/14/2026')).toBeNull()
  })

  it('returns null for blanks and nonsense', () => {
    expect(parseSheetDate('')).toBeNull()
    expect(parseSheetDate('next monday')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Row rules
// ---------------------------------------------------------------------------

function row(overrides: Partial<ParsedEmployeeRow> & { rowNumber: number }): ParsedEmployeeRow {
  return {
    employeeCode: 'SENT0001',
    name: 'A WORKER',
    departmentName: null,
    designationName: null,
    employeeTypeName: null,
    supervisorName: null,
    employmentType: null,
    employmentStatus: null,
    salaryBasis: null,
    joiningDate: '2026-04-01',
    exitDate: null,
    workEmail: null,
    mobileNumber: null,
    ...overrides,
  }
}

describe('validateParsedRows', () => {
  it('passes a well-formed sheet', () => {
    expect(validateParsedRows([row({ rowNumber: 2 }), row({ rowNumber: 3, employeeCode: 'SENT0002' })])).toEqual([])
  })

  it('reports a duplicate employee ID inside the file, naming the earlier row', () => {
    const problems = validateParsedRows([
      row({ rowNumber: 2, employeeCode: 'SENT0007' }),
      row({ rowNumber: 5, employeeCode: 'SENT0007' }),
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.rowNumber).toBe(5)
    expect(problems[0]?.message).toContain('row 2')
  })

  it('treats employee IDs as case-insensitive when spotting duplicates', () => {
    const problems = validateParsedRows([
      row({ rowNumber: 2, employeeCode: 'SENT0007' }),
      row({ rowNumber: 3, employeeCode: 'sent0007' }),
    ])
    expect(problems).toHaveLength(1)
  })

  it('reports a blank employee ID', () => {
    const problems = validateParsedRows([row({ rowNumber: 2, employeeCode: '  ' })])
    expect(problems[0]?.message).toContain('blank')
  })

  it('reports a blank name', () => {
    const problems = validateParsedRows([row({ rowNumber: 2, name: '' })])
    expect(problems.some((p) => p.message.includes('Name is blank'))).toBe(true)
  })

  it('reports a missing joining date', () => {
    const problems = validateParsedRows([row({ rowNumber: 2, joiningDate: null })])
    expect(problems.some((p) => p.message.includes('Joining date is missing'))).toBe(true)
  })

  it('reports an unreadable joining date rather than guessing', () => {
    const problems = validateParsedRows([row({ rowNumber: 2, joiningDate: '04/14/2026' })])
    expect(problems.some((p) => p.message.includes('not a date'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reading the workbook
// ---------------------------------------------------------------------------

async function sheetOf(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Employees')
  rows.forEach((values) => sheet.addRow(values))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('parseEmployeeSheet', () => {
  it('reads the Employee Master export layout', async () => {
    const buffer = await sheetOf([
      ['Employee ID', 'Name', 'Department', 'Section', 'Supply Type', 'Joining Date', 'Mobile'],
      ['SENT0601', 'NEW WORKER', 'AFR', 'FEEDING', 'Supply', '2026-04-01', '9876543210'],
      ['SENT0602', 'ANOTHER ONE', 'PROCESS', 'KILN & PH', 'PSR', '14/04/2026', ''],
    ])
    const parsed = await parseEmployeeSheet(buffer)

    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({
      employeeCode: 'SENT0601',
      name: 'NEW WORKER',
      departmentName: 'AFR',
      designationName: 'FEEDING',
      employeeTypeName: 'Supply',
      joiningDate: '2026-04-01',
      mobileNumber: '9876543210',
    })
    expect(parsed.rows[1]?.joiningDate).toBe('2026-04-14')
    expect(parsed.rows[1]?.mobileNumber).toBeNull()
  })

  it('ignores columns it does not know, and says which', async () => {
    const buffer = await sheetOf([
      ['Employee ID', 'Name', 'Joining Date', 'Locker Number'],
      ['SENT0601', 'NEW WORKER', '2026-04-01', 'L-12'],
    ])
    const parsed = await parseEmployeeSheet(buffer)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.ignoredColumns).toContain('Locker Number')
  })

  it('finds the header even when the export puts a title above it', async () => {
    const buffer = await sheetOf([
      ['Employee Master'],
      [],
      ['Employee ID', 'Name', 'Joining Date'],
      ['SENT0601', 'NEW WORKER', '2026-04-01'],
    ])
    const parsed = await parseEmployeeSheet(buffer)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]?.rowNumber).toBe(4)
  })

  it('skips blank spacer rows instead of reporting them', async () => {
    const buffer = await sheetOf([
      ['Employee ID', 'Name', 'Joining Date'],
      ['SENT0601', 'NEW WORKER', '2026-04-01'],
      [],
      ['SENT0602', 'ANOTHER ONE', '2026-04-02'],
    ])
    const parsed = await parseEmployeeSheet(buffer)
    expect(parsed.rows).toHaveLength(2)
  })

  it('refuses a sheet with no recognisable header', async () => {
    const buffer = await sheetOf([
      ['Who', 'When'],
      ['someone', 'sometime'],
    ])
    await expect(parseEmployeeSheet(buffer)).rejects.toThrow(/Employee ID/)
  })

  it('refuses a file that is not a workbook', async () => {
    await expect(parseEmployeeSheet(Buffer.from('employee id,name\n1,two'))).rejects.toThrow(/valid .xlsx/)
  })
})
