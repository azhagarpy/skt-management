import { describe, expect, it } from 'vitest'
import { findReportDefinition, monthsBetween, YEARLY_PARTICULARS } from './report-definitions.js'
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
  const row = (code: string, particulars: string) =>
    rows.find((entry) => entry.employee_code === code && entry.particulars === particulars)

  it('gives each employee a row per figure, in order, then rows for everyone', () => {
    const particulars = YEARLY_PARTICULARS.map((particular) => particular.label)
    expect(rows).toHaveLength(particulars.length * 3)
    expect(rows.slice(0, particulars.length).map((entry) => entry.particulars)).toEqual(particulars)
    expect(rows.map((entry) => entry.employee_code).filter((code, index, all) => all.indexOf(code) === index)).toEqual([
      'SENT7',
      'SENT20',
      'ALL',
    ])
  })

  it('puts each month in its own column with the total, total wages being gross plus overtime', () => {
    expect(row('SENT7', 'Gross Earnings')).toMatchObject({ m2026_08: 15000.1, m2026_09: 14000.2, range_total: 29000.3 })
    expect(row('SENT7', 'Holidays')).toMatchObject({ m2026_08: 1.5, range_total: 1.5 })
    expect(row('SENT7', 'Holiday Wages (without SA)')).toMatchObject({ m2026_08: 812.4 })
    expect(row('SENT7', 'Total Wages')).toMatchObject({ m2026_08: 15600.1, range_total: 29600.3 })
    expect(row('SENT7', 'Net Salary')).toMatchObject({ m2026_08: 13937.6, m2026_09: 12200.2, range_total: 26137.8 })
  })

  it('leaves a month blank for someone not paid in it', () => {
    expect(row('SENT20', 'Gross Earnings')?.m2026_08).toBeUndefined()
    expect(row('SENT20', 'Gross Earnings')).toMatchObject({ m2026_09: 9000, range_total: 9000 })
  })

  it('adds up every employee, month by month, to the paisa', () => {
    expect(row('ALL', 'Gross Earnings')).toMatchObject({ m2026_08: 15000.1, m2026_09: 23000.2, range_total: 38000.3 })
    expect(row('ALL', 'Net Salary')).toMatchObject({ range_total: 35137.8 })
  })

  it('has no everyone rows for a single employee', () => {
    expect(pivotYearlySalary([monthRow('7', 8, { gross_earnings: '100' })]).some((entry) => entry.employee_code === 'ALL')).toBe(false)
  })
})

describe('Yearly Salary columns', () => {
  const definition = findReportDefinition('yearly-salary')!

  it('runs across the year end', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('has the months as columns, then their total', () => {
    const columns = definition.columnsFor!({ fromMonth: '2026-01', toMonth: '2026-12' })
    expect(columns.map((column) => column.key).slice(4, 6)).toEqual(['particulars', 'm2026_01'])
    expect(columns.filter((column) => column.dropWhenEmpty).map((column) => column.label)).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((month) => `${month} 2026`),
    )
    expect(columns[columns.length - 1]).toMatchObject({ key: 'range_total', label: 'Total' })
    // A column mixes kinds of figure, so nothing is added up down it.
    expect(columns.some((column) => column.total)).toBe(false)
  })
})
