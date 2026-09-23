import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLABS,
  assembleTaxReport,
  slabLabels,
  slabsSchema,
  taxFor,
  taxReportQuerySchema,
  toTaxExcel,
} from './tax-report.js'

describe('taxFor', () => {
  it('follows the slab table: nil up to 21,000, then 120 / 300 / 590 / 890, then 1,180 above 75,000', () => {
    const cases: [number, number][] = [
      [0, 0],
      [21_000, 0],
      [21_001, 120],
      [30_000, 120],
      [30_001, 300],
      [45_000, 300],
      [45_001, 590],
      [60_000, 590],
      [60_001, 890],
      [75_000, 890],
      [75_001, 1180],
      [14_612_085, 1180],
    ]
    for (const [wages, tax] of cases) expect(taxFor(wages, DEFAULT_SLABS), `wages ${wages}`).toBe(tax)
  })

  it('treats a wage between two whole rupees as belonging to the upper slab', () => {
    expect(taxFor(21_000.5, DEFAULT_SLABS)).toBe(120)
  })

  it('charges nothing when no slabs are set', () => {
    expect(taxFor(100_000, [])).toBe(0)
  })
})

describe('slabLabels', () => {
  it('names each band by the wages it covers', () => {
    expect(slabLabels(DEFAULT_SLABS)).toEqual([
      '21000 Upto',
      '21001-30000',
      '30001-45000',
      '45001-60000',
      '60001-75000',
      '75001- Above',
    ])
  })
})

describe('slabsSchema', () => {
  it('accepts the standard bands', () => {
    expect(slabsSchema.safeParse({ slabs: DEFAULT_SLABS }).success).toBe(true)
  })

  it('needs the last slab to be open-ended, and only the last', () => {
    expect(slabsSchema.safeParse({ slabs: [{ upTo: 10_000, taxAmount: 0 }] }).success).toBe(false)
    expect(
      slabsSchema.safeParse({
        slabs: [
          { upTo: null, taxAmount: 0 },
          { upTo: null, taxAmount: 5 },
        ],
      }).success,
    ).toBe(false)
  })

  it('needs limits to rise strictly', () => {
    const result = slabsSchema.safeParse({
      slabs: [
        { upTo: 30_000, taxAmount: 0 },
        { upTo: 30_000, taxAmount: 100 },
        { upTo: null, taxAmount: 200 },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative tax amount and an empty list', () => {
    expect(slabsSchema.safeParse({ slabs: [{ upTo: null, taxAmount: -1 }] }).success).toBe(false)
    expect(slabsSchema.safeParse({ slabs: [] }).success).toBe(false)
  })
})

describe('taxReportQuerySchema', () => {
  it('accepts a half-year and rejects a backwards or over-long period', () => {
    expect(taxReportQuerySchema.safeParse({ fromYear: 2025, fromMonth: 10, toYear: 2026, toMonth: 3 }).success).toBe(true)
    expect(taxReportQuerySchema.safeParse({ fromYear: 2026, fromMonth: 3, toYear: 2025, toMonth: 10 }).success).toBe(false)
    expect(taxReportQuerySchema.safeParse({ fromYear: 2025, fromMonth: 1, toYear: 2026, toMonth: 2 }).success).toBe(false)
  })
})

// Oct-25 to Mar-26, as in the P.TAX workbook.
const query = taxReportQuerySchema.parse({ fromYear: 2025, fromMonth: 10, toYear: 2026, toMonth: 3 })
const months = ['Oct 2025', 'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026'].map((label, index) => ({
  year: index < 3 ? 2025 : 2026,
  month: index < 3 ? 10 + index : index - 2,
  label,
  runStatus: 'LOCKED',
}))

function employee(code: string, department: string | null, wages: number[]) {
  return {
    employeeId: code,
    employeeCode: code,
    employeeName: `Name ${code}`,
    departmentName: department,
    months: wages.map((amount) => ({ wages: amount })),
    totalWages: wages.reduce((sum, amount) => sum + amount, 0),
  }
}

describe('assembleTaxReport', () => {
  // SENT0007 from the workbook: 88,061 over the six months, P.Tax 1,180.
  const rows = [
    employee('SENT0007', 'SKT', [13525, 13525, 14066, 15977, 15800, 15168]),
    employee('TATA0003', 'TATA', [18240, 15960, 19760, 12920, 19000, 18240]),
    employee('TATA0004', 'TATA', [18240, 20520, 18240, 17480, 19760, 18240]),
    employee('LOW1', 'SKT', [2000, 2000, 2000, 2000, 2000, 2000]),
  ]

  it('applies the slab to the total wages over the period, not to a single month', () => {
    const report = assembleTaxReport(months, rows, DEFAULT_SLABS, query)
    const skt = report.groups.find((group) => group.departmentName === 'SKT')!
    expect(skt.rows.find((row) => row.employeeCode === 'SENT0007')).toMatchObject({ totalWages: 88061, tax: 1180 })
    // 12,000 in total is below the 21,000 threshold.
    expect(skt.rows.find((row) => row.employeeCode === 'LOW1')).toMatchObject({ totalWages: 12000, tax: 0 })
  })

  it('groups by department with per-month and grand totals', () => {
    const report = assembleTaxReport(months, rows, DEFAULT_SLABS, query)
    expect(report.groups.map((group) => group.departmentName)).toEqual(['SKT', 'TATA'])
    const tata = report.groups[1]!
    expect(tata.totals.tax).toBe(2360)
    expect(tata.totals.wages[0]).toBe(36480)
    expect(report.totals).toMatchObject({ employees: 4, tax: 1180 + 2360 })
    expect(report.slabs[1]).toMatchObject({ label: '21001-30000', taxAmount: 120 })
  })
})

describe('toTaxExcel', () => {
  it('writes a sheet per department laid out like the P.TAX workbook, with the slab table beside it', async () => {
    const report = assembleTaxReport(
      months,
      [
        employee('TATA0003', 'TATA', [18240, 15960, 19760, 12920, 19000, 18240]),
        employee('SENT0007', 'SKT', [13525, 13525, 14066, 15977, 15800, 15168]),
      ],
      DEFAULT_SLABS,
      query,
    )
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await toTaxExcel(report, 'M/s Senthilkumar Transport')) as unknown as ArrayBuffer)

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['SKT', 'TATA'])
    const sheet = workbook.getWorksheet('TATA')!
    expect(sheet.getCell('A1').value).toBe('M/s Senthilkumar Transport')
    expect(sheet.getCell('A2').value).toBe('Oct-25 to Mar-26 Workmen wages details for ( Panchayat tax )')
    expect(sheet.getRow(3).getCell(1).value).toBe('Sr.No')
    expect(sheet.getRow(3).getCell(3).value).toBe('Emp Name')
    expect(sheet.getRow(3).getCell(10).value).toBe('Total Wages')
    expect(sheet.getRow(3).getCell(11).value).toBe('P.Tax')
    expect(sheet.getRow(4).getCell(2).value).toBe('TATA0003')
    expect(sheet.getRow(4).getCell(10).value).toBe(104120)
    expect(sheet.getRow(4).getCell(11).value).toBe(1180)
    expect(sheet.getRow(5).getCell(1).value).toBe('Total')
    expect(sheet.getRow(5).getCell(11).value).toBe(1180)
    // The slab table: "21000 Upto -", "21001-30000 120", ...
    expect(sheet.getRow(3).getCell(13).value).toBe('21000 Upto')
    expect(sheet.getRow(3).getCell(14).value).toBe('-')
    expect(sheet.getRow(4).getCell(13).value).toBe('21001-30000')
    expect(sheet.getRow(4).getCell(14).value).toBe(120)
    expect(sheet.getRow(8).getCell(13).value).toBe('75001- Above')
  })

  it('still produces a valid workbook when there is nothing to report', async () => {
    const report = assembleTaxReport(months, [], DEFAULT_SLABS, query)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await toTaxExcel(report, 'SKT')) as unknown as ArrayBuffer)
    expect(workbook.worksheets).toHaveLength(1)
  })
})
