import { describe, expect, it } from 'vitest'
import { amountInWords, longDate, money, shortDate, type Letterhead } from '../../utils/pdf.js'
import { renderPayslipPdf, type PayslipPdfData } from '../payslips/payslip-pdf.js'
import { cleanPurpose } from './noc.service.js'
import { renderNocPdf, type NocData } from './noc-pdf.js'

/** Page objects in the file; the dictionaries are written uncompressed. */
const pageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

const letterhead: Letterhead = {
  name: 'SENTHILKUMAR TRANSPORT',
  addressLines: ['160 north street', 'Ariyalur, Tamilnadu 621701'],
  contactLine: '+91 9047767733   |   office@example.com',
  identifiers: [],
  city: 'Ariyalur',
  logo: null,
}

describe('amountInWords', () => {
  it('writes rupees in the Indian system', () => {
    expect(amountInWords(15_618)).toBe('Rupees Fifteen Thousand Six Hundred Eighteen Only')
    expect(amountInWords(100_000)).toBe('Rupees One Lakh Only')
    expect(amountInWords(12_34_56_789)).toBe(
      'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only',
    )
    expect(amountInWords(0)).toBe('Rupees Zero Only')
  })

  it('adds paise, and does not lose them to floating point', () => {
    expect(amountInWords(567.12)).toBe('Rupees Five Hundred Sixty Seven and Twelve Paise Only')
    expect(amountInWords(0.29)).toBe('Rupees Zero and Twenty Nine Paise Only')
    expect(amountInWords(1.1)).toBe('Rupees One and Ten Paise Only')
  })

  it('marks a negative amount', () => {
    expect(amountInWords(-250)).toBe('Minus Rupees Two Hundred Fifty Only')
  })
})

describe('formatting', () => {
  it('groups digits the Indian way without a currency symbol', () => {
    expect(money(1_234_567.5)).toBe('12,34,567.50')
    expect(money('15618')).toBe('15,618.00')
  })

  it('formats dates', () => {
    expect(longDate('2026-08-15')).toBe('15 August 2026')
    expect(shortDate('2026-08-05')).toBe('5 Aug 2026')
  })
})

describe('cleanPurpose', () => {
  it('keeps the purpose to one clean phrase', () => {
    expect(cleanPurpose('  availing a\nbank   loan. ')).toBe('availing a bank loan')
    expect(cleanPurpose('')).toBeNull()
    expect(cleanPurpose('   ')).toBeNull()
    expect(cleanPurpose(undefined)).toBeNull()
    expect(cleanPurpose('x'.repeat(500))?.length).toBe(200)
  })
})

describe('renderNocPdf', () => {
  const base: NocData = {
    letterhead,
    employeeName: 'SAMIDURAI P P',
    employeeCode: 'SENT0020',
    designation: 'CEMENT MILL',
    department: 'MECHANICAL-2',
    joiningDate: '2012-05-01',
    exitDate: null,
    isCurrent: true,
    purpose: 'availing a bank loan',
    issuedOn: '2026-09-21',
  }

  it('produces a one page PDF', async () => {
    const pdf = await renderNocPdf(base)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBe(1)
  })

  it('handles an employee who has left, no purpose and missing details', async () => {
    const pdf = await renderNocPdf({
      ...base,
      isCurrent: false,
      exitDate: '2025-03-31',
      purpose: null,
      designation: null,
      department: null,
    })
    expect(pageCount(pdf)).toBe(1)
  })

  it('keeps very long names and purposes on the page', async () => {
    const pdf = await renderNocPdf({
      ...base,
      employeeName: 'A VERY LONG EMPLOYEE NAME '.repeat(6).trim(),
      purpose: 'applying for a passport and a long list of other things '.repeat(3).trim(),
    })
    expect(pageCount(pdf)).toBe(1)
  })
})

describe('renderPayslipPdf', () => {
  const component = (index: number, type: string, source = 'SALARY_STRUCTURE') => ({
    id: String(index),
    component_code: `C${index}`,
    component_name: `Component number ${index}`,
    component_type: type,
    source,
    amount: '1250.00',
    notes: null,
  })

  const payslip = (components: unknown[]): PayslipPdfData =>
    ({
      letterhead,
      item: {
        employee_name: 'SAMIDURAI P P',
        employee_code: 'SENT0020',
        department_name: 'MECHANICAL-2',
        designation_name: 'CEMENT MILL',
        run_year: 2026,
        run_month: 8,
        calendar_days: '31',
        paid_days: '26',
        present_days: '26',
        absent_days: '5',
        leave_days: '0',
        holiday_days: '0',
        weekly_off_days: '0',
        gross_earnings: '17550.00',
        total_deductions: '1932.00',
        net_salary: '15618.00',
        paid_amount: '0',
        pending_amount: '15618.00',
        payment_status: 'PENDING',
      },
      period: { start: '2026-07-21', end: '2026-08-20' },
      components,
      bank: { bank_name: 'KVB', account_number: '1234567890', ifsc_code: 'KVBL0001867' },
      uan: '100949168229',
      esiNumber: '6380708175',
      locationName: 'Plant',
      photo: null,
      payments: [],
      generatedOn: '2026-09-21',
    }) as unknown as PayslipPdfData

  it('fits a normal payslip on one page', async () => {
    const pdf = await renderPayslipPdf(
      payslip([
        component(1, 'EARNING'),
        component(2, 'EARNING'),
        component(3, 'DEDUCTION'),
        component(4, 'EMPLOYER_CONTRIBUTION'),
      ]),
    )
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBe(1)
  })

  it('moves the pay tables to a second page when a long structure will not fit under the header', async () => {
    // Tables are kept whole (a fresh page holds about 30 rows); real structures have around ten lines.
    const long = Array.from({ length: 24 }, (_, index) => component(index, 'EARNING'))
    const pdf = await renderPayslipPdf(payslip(long))
    expect(pageCount(pdf)).toBe(2)
  })

  it('renders a payslip with nothing deducted', async () => {
    const pdf = await renderPayslipPdf(payslip([component(1, 'EARNING')]))
    expect(pageCount(pdf)).toBe(1)
  })
})
