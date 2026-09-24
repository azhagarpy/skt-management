import {
  buildPdf,
  COLOR,
  drawFooter,
  drawLetterhead,
  ensureSpace,
  longDate,
  PAGE,
  type Letterhead,
  type Pdf,
} from '../../utils/pdf.js'

/**
 * The statutory Letter of Appointment: the sixteen numbered particulars every
 * employee is entitled to receive, on the organization's letterhead.
 *
 * The numbering and wording follow the prescribed form rather than anything
 * this application would choose for itself, which is the point - the letter is
 * a compliance document, so the labels are reproduced as written and a
 * particular that has no value on record prints as "NA" rather than being
 * dropped, so the reader can see it was asked.
 */

export interface AppointmentLetterData {
  letterhead: Letterhead
  employeeName: string
  employeeCode: string
  dateOfBirth: string | null
  parentName: string | null
  aadhaarNumber: string | null
  labourIdentificationNumber: string | null
  uanNumber: string | null
  esiNumber: string | null
  designation: string | null
  employmentType: string
  skillCategory: string | null
  joiningDate: string
  /** Basic, dearness allowance and anything else that makes up the wage. */
  wageLines: string[]
  otherAllowanceLines: string[]
  /** What the wage figures are per; null when the employee has no salary assigned. */
  wageBasis: 'MONTHLY' | 'DAILY' | null
  pfApplicable: boolean
  esiApplicable: boolean
  duties: string | null
  /** Chapter VII applies to women employees; the form asks the question directly. */
  maternityBenefitApplicable: boolean
  otherInformation: string | null
  issuedOn: string
}

const NUMERAL_X = PAGE.left + 10
const NUMERAL_WIDTH = 30
const LABEL_X = NUMERAL_X + NUMERAL_WIDTH
const LABEL_WIDTH = 228
const VALUE_X = LABEL_X + LABEL_WIDTH + 14
const VALUE_WIDTH = PAGE.right - 10 - VALUE_X
const ROW_PADDING = 7

interface Particular {
  numeral: string
  label: string
  /** One line per element; an empty list prints as "NA". */
  value: string[]
}

/** "690381331482" -> "6903 8133 1482", which is how the number is written. */
function groupAadhaar(value: string): string {
  return value.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ')
}

/** SEMI_SKILLED -> "Semi skilled". */
function humanise(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function particulars(data: AppointmentLetterData): Particular[] {
  return [
    { numeral: '(i)', label: 'Name of employee', value: [data.employeeName] },
    { numeral: '(ii)', label: 'Date of birth', value: data.dateOfBirth ? [longDate(data.dateOfBirth)] : [] },
    { numeral: '(iii)', label: "Father's / Mother's name", value: data.parentName ? [data.parentName] : [] },
    {
      numeral: '(iv)',
      label: 'Aadhaar number (after obtaining consent)',
      value: data.aadhaarNumber ? [groupAadhaar(data.aadhaarNumber)] : [],
    },
    {
      numeral: '(v)',
      label: 'Labour Identification Number of the establishment',
      value: data.labourIdentificationNumber ? [data.labourIdentificationNumber] : [],
    },
    {
      numeral: '(vi)',
      label: 'Universal Account Number and / or Insurance number (if available)',
      value: [
        data.uanNumber ? `UAN: ${data.uanNumber}` : 'UAN: NA',
        data.esiNumber ? `ESIC insurance number: ${data.esiNumber}` : 'ESIC insurance number: NA',
      ],
    },
    { numeral: '(vii)', label: 'Designation', value: data.designation ? [data.designation] : [] },
    {
      numeral: '(viii)',
      label: 'Type of employment (Regular / Fixed-term employment / Contractual)',
      value: [humanise(data.employmentType)],
    },
    {
      numeral: '(ix)',
      label: 'Category of skill',
      value: data.skillCategory ? [humanise(data.skillCategory)] : [],
    },
    { numeral: '(x)', label: 'Date of joining', value: [longDate(data.joiningDate)] },
    {
      numeral: '(xi)',
      label: 'Wages / Basic / Pay and Dearness Allowance',
      value: data.wageLines,
    },
    {
      numeral: '(xii)',
      label: 'Other allowance including accommodation, whichever is / are applicable',
      value: data.otherAllowanceLines,
    },
    {
      numeral: '(xiii)',
      label: 'Applicability of social security benefits',
      value: [
        `Employees' Provident Fund Organisation: ${data.pfApplicable ? 'Yes' : 'No'}`,
        `Employees' State Insurance Corporation: ${data.esiApplicable ? 'Yes' : 'No'}`,
      ],
    },
    { numeral: '(xiv)', label: 'Broad nature of duties to be performed', value: data.duties ? [data.duties] : [] },
    {
      numeral: '(xv)',
      label:
        'Benefits available under Chapter VII (Maternity Benefit) of the Code on Social Security, 2020 (36 of 2020), in case of a woman employee',
      value: [data.maternityBenefitApplicable ? 'Applicable' : 'Not applicable'],
    },
    {
      numeral: '(xvi)',
      label: 'Any other information',
      value: data.otherInformation ? [data.otherInformation] : [],
    },
  ]
}

/** Draws one particular and returns the y below it, starting a page if it will not fit. */
function drawParticular(doc: Pdf, row: Particular, y: number, shaded: boolean): number {
  const value = row.value.length > 0 ? row.value : ['NA']

  doc.font('Helvetica').fontSize(9.5)
  const labelHeight = doc.heightOfString(row.label, { width: LABEL_WIDTH, lineGap: 1.5 })
  doc.font('Helvetica-Bold').fontSize(9.5)
  const valueHeight = value.reduce(
    (total, line) => total + doc.heightOfString(line, { width: VALUE_WIDTH, lineGap: 1.5 }),
    0,
  )
  const height = Math.max(labelHeight, valueHeight) + ROW_PADDING * 2

  const top = ensureSpace(doc, y, height)
  if (shaded) doc.rect(PAGE.left, top, PAGE.width, height).fill(COLOR.band)
  doc.rect(PAGE.left, top, PAGE.width, height).lineWidth(0.5).strokeColor(COLOR.border).stroke()

  doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.muted)
  doc.text(row.numeral, NUMERAL_X, top + ROW_PADDING, { width: NUMERAL_WIDTH, lineGap: 1.5 })
  doc.text(row.label, LABEL_X, top + ROW_PADDING, { width: LABEL_WIDTH, lineGap: 1.5 })

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR.ink)
  let valueY = top + ROW_PADDING
  for (const line of value) {
    doc.text(line, VALUE_X, valueY, { width: VALUE_WIDTH, lineGap: 1.5 })
    valueY = doc.y
  }

  return top + height
}

export function drawAppointmentLetter(doc: Pdf, data: AppointmentLetterData): void {
  let y = drawLetterhead(doc, data.letterhead) + 28

  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR.accent).text('LETTER OF APPOINTMENT', PAGE.left, y, {
    width: PAGE.width,
    align: 'center',
    characterSpacing: 0.6,
  })
  y = doc.y + 4
  doc.moveTo(PAGE.left + 160, y).lineTo(PAGE.right - 160, y).lineWidth(1).strokeColor(COLOR.accent).stroke()
  y += 20

  const reference = `APL/${data.employeeCode}/${data.issuedOn.replace(/-/g, '')}`
  doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.muted)
  doc.text(`Ref. No: ${reference}`, PAGE.left, y, { width: PAGE.width / 2, lineBreak: false })
  doc.text(`Date: ${longDate(data.issuedOn)}`, PAGE.left + PAGE.width / 2, y, {
    width: PAGE.width / 2,
    align: 'right',
    lineBreak: false,
  })
  y += 26

  doc.font('Helvetica').fontSize(10).fillColor(COLOR.ink)
  doc.text(
    `Dear ${data.employeeName}, we are pleased to appoint you on the terms set out below. This letter is issued under the Code on Social Security, 2020 and the rules made under it.`,
    PAGE.left,
    y,
    { width: PAGE.width, align: 'justify', lineGap: 3 },
  )
  y = doc.y + 16

  particulars(data).forEach((row, index) => {
    y = drawParticular(doc, row, y, index % 2 === 0)
  })

  y += 22
  y = ensureSpace(doc, y, 130)
  const period = data.wageBasis === 'DAILY' ? 'a full day worked' : 'a full month'
  doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.muted).text(
    `The wages shown above are the entitlement for ${period} as at the date of issue, and are subject to attendance, statutory deductions and any subsequent revision.`,
    PAGE.left,
    y,
    { width: PAGE.width, align: 'justify', lineGap: 3 },
  )
  y = doc.y + 30

  const blockX = PAGE.right - 200
  doc.font('Helvetica').fontSize(10).fillColor(COLOR.ink).text(`For ${data.letterhead.name}`, blockX, y, {
    width: 200,
    align: 'right',
    lineBreak: false,
  })
  const lineY = y + 60
  doc.moveTo(blockX, lineY).lineTo(PAGE.right, lineY).lineWidth(0.75).strokeColor(COLOR.ink).stroke()
  doc.font('Helvetica-Bold').fontSize(10).text('Signature of employer', blockX, lineY + 6, {
    width: 200,
    align: 'right',
    lineBreak: false,
  })

  doc.moveTo(PAGE.left, lineY).lineTo(PAGE.left + 200, lineY).lineWidth(0.75).strokeColor(COLOR.ink).stroke()
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.ink).text('Signature of employee', PAGE.left, lineY + 6, {
    width: 200,
    lineBreak: false,
  })

  drawFooter(doc, "Issued from the Company's employment records. Amounts are in INR.")
}

export function renderAppointmentLetterPdf(data: AppointmentLetterData): Promise<Buffer> {
  return buildPdf(`Letter of Appointment ${data.employeeCode}`, (doc) => drawAppointmentLetter(doc, data))
}
