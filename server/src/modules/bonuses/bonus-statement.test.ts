import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { assembleStatement, statementQuerySchema, toStatementExcel, type PayrollLine } from './bonus-statement.js'

/** Fourteen payroll months, Jan 2025 - Feb 2026, like the 14 periods of the bonus workbook. */
const query = statementQuerySchema.parse({ fromYear: 2025, fromMonth: 1, toYear: 2026, toMonth: 2 })

function lines(employee: { id: string; code: string; department: string }, days: number[], wages: number[]): PayrollLine[] {
  return days.map((manDays, index) => ({
    employee_id: employee.id,
    employee_code: employee.code,
    employee_name: employee.code,
    department_name: employee.department,
    section_name: 'Unskilled',
    year: 2025 + Math.floor(index / 12),
    month: (index % 12) + 1,
    man_days: String(manDays),
    wages: String(wages[index] ?? 0),
  }))
}

// SENT0007 from the workbook: 304 man days, wages 170,759, bonus @ 8.33% = 14,224.
const SENT0007 = lines(
  { id: 'a', code: 'SENT0007', department: 'SENTHILKUMAR TRANSPORT' },
  [5, 21, 24, 27, 26, 26, 24, 25, 25, 26, 5, 21, 25, 24],
  [2630, 11361, 12984, 14607, 14066, 14066, 12984, 13525, 13525, 14066, 2705, 13272, 15800, 15168],
)

// SENT0229 from the workbook: only 45.5 man days, wages 28,756, bonus 2,395.
const SENT0229 = lines(
  { id: 'b', code: 'SENT0229', department: 'SENTHILKUMAR TRANSPORT' },
  [0, 0, 0, 13, 19, 13.5, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 8216, 12008, 8532, 0, 0, 0, 0, 0, 0, 0, 0],
)

describe('assembleStatement', () => {
  it('reproduces the workbook totals and bonus @ 8.33%', () => {
    const statement = assembleStatement([...SENT0007, ...SENT0229], [], query)
    expect(statement.months).toHaveLength(14)
    expect(statement.months[0]).toMatchObject({ label: 'Jan 2025', runStatus: null })

    const first = statement.rows.find((row) => row.employeeCode === 'SENT0007')
    expect(first).toMatchObject({ totalManDays: 304, totalWages: 170759, eligible: true, bonus: 14224 })

    const second = statement.rows.find((row) => row.employeeCode === 'SENT0229')
    expect(second).toMatchObject({ totalManDays: 45.5, totalWages: 28756, eligible: true, bonus: 2395 })
  })

  it('gives nothing to someone below the minimum man days, and leaves them out of the summary', () => {
    const strict = statementQuerySchema.parse({ ...query, minManDays: 50 })
    const statement = assembleStatement([...SENT0007, ...SENT0229], [], strict)

    const second = statement.rows.find((row) => row.employeeCode === 'SENT0229')
    expect(second).toMatchObject({ eligible: false, bonus: 0 })

    expect(statement.summary).toEqual([
      { departmentName: 'SENTHILKUMAR TRANSPORT', employees: 1, manDays: 304, bonus: 14224 },
    ])
    expect(statement.totals).toEqual({ employees: 1, manDays: 304, wages: 170759, bonus: 14224 })
  })

  it('groups the summary by department with a grand total', () => {
    const other = lines({ id: 'c', code: 'X1', department: 'ASHIQ EARTH MOVERS' }, [30], [10000])
    const statement = assembleStatement([...SENT0007, ...other], [], query)
    expect(statement.summary.map((row) => row.departmentName)).toEqual(['ASHIQ EARTH MOVERS', 'SENTHILKUMAR TRANSPORT'])
    expect(statement.totals.employees).toBe(2)
    expect(statement.totals.bonus).toBe(14224 + 833)
  })

  it('reports each month\'s payroll status so a missing or unapproved month can be flagged', () => {
    const statement = assembleStatement(SENT0007, [{ year: 2025, month: 2, status: 'LOCKED' }], query)
    expect(statement.months[1]?.runStatus).toBe('LOCKED')
    expect(statement.months[2]?.runStatus).toBeNull()
  })

  it('does not count a month outside the range', () => {
    const stray = { ...SENT0007[0]!, year: 2030, month: 1 }
    const statement = assembleStatement([...SENT0007, stray], [], query)
    expect(statement.rows[0]?.totalManDays).toBe(304)
  })
})

describe('statementQuerySchema', () => {
  it('defaults to 8.33% and a 30 man-day minimum', () => {
    expect(query.percentage).toBe(8.33)
    expect(query.minManDays).toBe(30)
  })

  it('rejects a backwards or over-long range', () => {
    expect(statementQuerySchema.safeParse({ fromYear: 2026, fromMonth: 3, toYear: 2025, toMonth: 4 }).success).toBe(false)
    expect(statementQuerySchema.safeParse({ fromYear: 2020, fromMonth: 1, toYear: 2026, toMonth: 4 }).success).toBe(false)
  })
})

describe('toStatementExcel', () => {
  it('lays the statement out like the bonus workbook, with a department summary', async () => {
    const statement = assembleStatement(SENT0007, [], query)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await toStatementExcel(statement, 'SKT')) as unknown as ArrayBuffer)

    const master = workbook.getWorksheet('Master_Bonus')!
    expect(master.getCell('C1').value).toBe('Bonus Jan 2025 to Feb 2026')
    expect(master.getCell('F1').value).toBe('Jan 2025')
    expect(master.getRow(2).getCell(6).value).toBe('TOTAL PRESENT')
    expect(master.getRow(2).getCell(7).value).toBe('MONTHLY WAGES')
    // 5 identity columns + 14 months x 2 + 4 totals.
    expect(master.getRow(2).getCell(37).value).toBe('Bonus @ 8.33%')
    expect(master.getRow(3).getCell(2).value).toBe('SENT0007')
    expect(master.getRow(3).getCell(37).value).toBe(14224)
    expect(master.getRow(4).getCell(1).value).toBe('Total')

    const summary = workbook.getWorksheet('Summary')!
    expect(summary.getRow(3).getCell(1).value).toBe('Row Labels')
    expect(summary.getRow(4).values).toEqual([undefined, 'SENTHILKUMAR TRANSPORT', 1, 304, 14224])
    expect(summary.getRow(5).getCell(1).value).toBe('Grand Total')
  })
})
