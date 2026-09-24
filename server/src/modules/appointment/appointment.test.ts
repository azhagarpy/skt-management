import { describe, expect, it } from 'vitest'
import type { Letterhead } from '../../utils/pdf.js'
import { cleanOtherInformation } from './appointment.service.js'
import { renderAppointmentLetterPdf, type AppointmentLetterData } from './appointment-pdf.js'

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

describe('cleanOtherInformation', () => {
  it('keeps the note to one clean line', () => {
    expect(cleanOtherInformation('  subject to a\nthree   month probation ')).toBe(
      'subject to a three month probation',
    )
    expect(cleanOtherInformation('')).toBeNull()
    expect(cleanOtherInformation('   ')).toBeNull()
    expect(cleanOtherInformation(undefined)).toBeNull()
    expect(cleanOtherInformation('x'.repeat(900))?.length).toBe(300)
  })
})

describe('renderAppointmentLetterPdf', () => {
  const base: AppointmentLetterData = {
    letterhead,
    employeeName: 'KARTHIKEYAN P',
    employeeCode: 'SENT0781',
    dateOfBirth: '1990-05-25',
    parentName: 'PUNNIYAMOORTHY',
    aadhaarNumber: '690381331482',
    labourIdentificationNumber: '1-8766-8806-8',
    uanNumber: '100863309520',
    esiNumber: '5013609876',
    designation: 'SUPERVISOR',
    employmentType: 'CONTRACT',
    skillCategory: 'SKILLED',
    joiningDate: '2015-04-03',
    wageLines: ['Basic: INR 12,000.00', 'Dearness Allowance: INR 3,000.00'],
    otherAllowanceLines: ['House Rent Allowance: INR 2,400.00'],
    wageBasis: 'MONTHLY',
    pfApplicable: true,
    esiApplicable: true,
    duties: 'Supervising the loading and dispatch of cement at the plant.',
    maternityBenefitApplicable: false,
    otherInformation: null,
    issuedOn: '2026-09-23',
  }

  it('produces a PDF with every particular filled', async () => {
    const pdf = await renderAppointmentLetterPdf(base)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1)
  })

  it('still renders when the record has none of the optional particulars', async () => {
    const pdf = await renderAppointmentLetterPdf({
      ...base,
      dateOfBirth: null,
      parentName: null,
      aadhaarNumber: null,
      labourIdentificationNumber: null,
      uanNumber: null,
      esiNumber: null,
      designation: null,
      skillCategory: null,
      wageLines: [],
      otherAllowanceLines: [],
      wageBasis: null,
      pfApplicable: false,
      esiApplicable: false,
      duties: null,
    })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1)
  })

  it('keeps long duties and many wage lines inside the document', async () => {
    const pdf = await renderAppointmentLetterPdf({
      ...base,
      duties: 'Supervising loading, dispatch, weighbridge records and shift handover at the plant. '.repeat(4).trim(),
      wageLines: Array.from({ length: 8 }, (_, index) => `Component ${index + 1}: INR 1,250.00`),
      otherAllowanceLines: Array.from({ length: 6 }, (_, index) => `Allowance ${index + 1}: INR 750.00`),
      wageBasis: 'DAILY',
      otherInformation: 'Subject to a three month probation and the standing orders of the establishment.',
    })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1)
  })
})
