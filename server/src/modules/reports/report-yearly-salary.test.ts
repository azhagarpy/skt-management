import { describe, expect, it } from 'vitest'
import { findReportDefinition, monthsBetween } from './report-definitions.js'
import { pivotYearlySalary } from './report-yearly-salary.js'

const monthRow = (employee: string, month: number, figures: Record<string, string | number>) => ({
  employee_id: employee,
  employee_code: `SENT${employee}`,
  employee_name: `Employee ${employee}`,
  department_name: 'PROCESS',
  designation_name: 'KILN',
  run_year: 2026,
  run_month: month,
  eligible_holidays: 0,
  holiday_wages: 0,
  gross_earnings: '0',
  pf_employee: '0',
  esi_employee: '0',
  ptax: '0',
  lwf: '0',
  other_deductions: '0',
  total_deductions: '0',
  overtime_amount: '0',
  total_credits: '0',
  net_salary: '0',
  ...figures,
})

describe('pivotYearlySalary', () => {
  const rows = pivotYearlySalary([
    monthRow('7', 8, {
      eligible_holidays: 1.5,
      holiday_wages: 812.4,
      gross_earnings: '15000.10',
      pf_employee: '1800.00',
      total_deductions: '1912.50',
      overtime_amount: '600.00',
      total_credits: '250.00',
      net_salary: '13937.60',
    }),
    monthRow('7', 9, { gross_earnings: '14000.20', total_deductions: '1800.00', net_salary: '12200.20' }),
    monthRow('20', 9, { gross_earnings: '9000.00', net_salary: '9000.00' }),
  ])

  it('gives each employee one row, in the order they come', () => {
    expect(rows.map((row) => row.employee_code)).toEqual(['SENT7', 'SENT20'])
  })

  it('puts each month in its own columns, total wages being gross plus overtime', () => {
    expect(rows[0]).toMatchObject({
      m2026_08_holidays: 1.5,
      m2026_08_holiday_wages: 812.4,
      m2026_08_gross: 15000.1,
      m2026_08_overtime: 600,
      m2026_08_total_wages: 15600.1,
      m2026_08_deductions: 1912.5,
      m2026_08_credits: 250,
      m2026_08_net: 13937.6,
      m2026_09_gross: 14000.2,
      m2026_09_net: 12200.2,
    })
    expect(rows[1]?.m2026_08_gross).toBeUndefined()
  })

  it('totals every category over the months, to the paisa', () => {
    expect(rows[0]).toMatchObject({
      months: 2,
      eligible_holidays: 1.5,
      holiday_wages: 812.4,
      gross_earnings: 29000.3,
      pf_employee: 1800,
      total_deductions: 3712.5,
      overtime_amount: 600,
      total_wages: 29600.3,
      total_credits: 250,
      net_salary: 26137.8,
    })
  })
})

describe('Yearly Salary columns', () => {
  const definition = findReportDefinition('yearly-salary')!

  it('runs across the year end', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('has every figure for each month, then the totals', () => {
    const columns = definition.columnsFor!({ fromMonth: '2026-01', toMonth: '2026-12' })
    const january = columns.filter((column) => column.key.startsWith('m2026_01_'))
    expect(january.map((column) => column.label)).toEqual([
      'Jan 2026 Holidays',
      'Jan 2026 Holiday Wages',
      'Jan 2026 Gross',
      'Jan 2026 Overtime',
      'Jan 2026 Total Wages',
      'Jan 2026 Deductions',
      'Jan 2026 Other Credits',
      'Jan 2026 Net',
    ])
    expect(columns.filter((column) => column.dropWhenEmpty)).toHaveLength(12 * 8)
    expect(columns[columns.length - 1]?.key).toBe('net_salary')
  })
})
