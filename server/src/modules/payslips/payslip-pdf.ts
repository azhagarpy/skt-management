import { maskAccountNumber } from '../../utils/mask.js'
import { logger } from '../../utils/logger.js'
import {
  amountInWords,
  buildPdf,
  COLOR,
  drawFooter,
  drawLetterhead,
  ensureSpace,
  longDate,
  money,
  monthName,
  PAGE,
  shortDate,
  type Letterhead,
  type Pdf,
} from '../../utils/pdf.js'
import type { PayrollItemComponentRow, PayrollItemRow } from '../payroll/payroll.repository.js'

/**
 * One payslip, drawn as one page (more only if an unusually long salary
 * structure will not fit). Everything comes from the frozen payroll item and its
 * component snapshot; nothing is recalculated.
 */

export interface PayslipPdfData {
  letterhead: Letterhead
  item: PayrollItemRow
  period: { start: string; end: string } | null
  components: PayrollItemComponentRow[]
  bank: { bank_name: string; account_number: string; ifsc_code: string } | null
  /** Statutory identifiers, when the employee has them on file. */
  uan: string | null
  esiNumber: string | null
  /** Where the employee is based, when a location is set. */
  locationName: string | null
  /** The employee's photo, when one has been uploaded. */
  photo: Buffer | null
  /** Every recorded (non-reversed) payment against this payslip, oldest first. */
  payments: { date: string; amount: string; method: string; reference: string | null }[]
  generatedOn: string
}

const ROW_HEIGHT = 18
const NOTE_HEIGHT = 10
const HALF = (PAGE.width - 15) / 2

function cell(doc: Pdf, label: string, value: string, x: number, y: number, width: number): void {
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted).text(label.toUpperCase(), x + 8, y + 6, { width: width - 16, lineBreak: false })
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR.ink).text(value || '-', x + 8, y + 17, { width: width - 16, lineBreak: false, ellipsis: true })
}

interface TableRow {
  name: string
  note: string | null
  amount: string
}

/** One half of the earnings / deductions area. Returns the y just below its last row. */
function drawSide(doc: Pdf, x: number, y: number, title: string, rows: TableRow[]): number {
  doc.rect(x, y, HALF, 20).fill(COLOR.band)
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.accent)
  doc.text(title.toUpperCase(), x + 8, y + 6, { width: HALF - 100, lineBreak: false })
  doc.text('AMOUNT (INR)', x + HALF - 92, y + 6, { width: 84, align: 'right', lineBreak: false })

  let cursor = y + 20
  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.faint).text('None', x + 8, cursor + 5, { lineBreak: false })
    cursor += ROW_HEIGHT
  }
  for (const row of rows) {
    const height = ROW_HEIGHT + (row.note ? NOTE_HEIGHT : 0)
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink).text(row.name, x + 8, cursor + 5, { width: HALF - 108, lineBreak: false, ellipsis: true })
    doc.text(row.amount, x + HALF - 92, cursor + 5, { width: 84, align: 'right', lineBreak: false })
    if (row.note) {
      doc.fontSize(7.5).fillColor(COLOR.muted).text(row.note, x + 8, cursor + 16, { width: HALF - 16, lineBreak: false, ellipsis: true })
    }
    cursor += height
    doc.moveTo(x, cursor).lineTo(x + HALF, cursor).lineWidth(0.5).strokeColor(COLOR.border).stroke()
  }
  doc.lineWidth(1)
  return cursor
}

export function drawPayslipPage(doc: Pdf, data: PayslipPdfData): void {
  const { item, components } = data
  const year = item.run_year ?? 0
  const month = item.run_month ?? 1

  let y = drawLetterhead(doc, data.letterhead) + 12

  // --- Title band ------------------------------------------------------------
  doc.rect(PAGE.left, y, PAGE.width, 26).fill(COLOR.accent)
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#ffffff')
  doc.text(`PAYSLIP  -  ${monthName(month).toUpperCase()} ${year}`, PAGE.left + 12, y + 8, { width: PAGE.width / 2, lineBreak: false })
  if (data.period) {
    doc.font('Helvetica').fontSize(8.5)
    doc.text(`Pay period: ${shortDate(data.period.start)} to ${shortDate(data.period.end)}`, PAGE.left + PAGE.width / 2, y + 9, {
      width: PAGE.width / 2 - 12,
      align: 'right',
      lineBreak: false,
    })
  }
  y += 26

  // --- Employee details --------------------------------------------------------
  const bankValue = data.bank ? `${data.bank.bank_name}  ${maskAccountNumber(data.bank.account_number) ?? ''}`.trim() : '-'
  const details: [string, string][] = [
    ['Employee name', item.employee_name],
    ['Employee ID', item.employee_code],
    ['Department', item.department_name ?? '-'],
    ['Section', item.designation_name ?? '-'],
    ['Work location', data.locationName ?? '-'],
    ['UAN (PF)', data.uan ?? '-'],
    ['ESI number', data.esiNumber ?? '-'],
    ['Bank account', bankValue],
    ['IFSC', data.bank?.ifsc_code ?? '-'],
  ]
  const cellHeight = 34
  const boxHeight = Math.ceil(details.length / 2) * cellHeight
  // A photo panel narrows the label/value grid rather than growing the box.
  const photoWidth = data.photo ? 64 : 0
  const gridWidth = PAGE.width - photoWidth
  doc.rect(PAGE.left, y, PAGE.width, boxHeight).lineWidth(0.75).strokeColor(COLOR.border).stroke()
  details.forEach(([label, value], index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    cell(doc, label, value, PAGE.left + column * (gridWidth / 2), y + row * cellHeight, gridWidth / 2)
  })
  for (let row = 1; row < Math.ceil(details.length / 2); row += 1) {
    doc.moveTo(PAGE.left, y + row * cellHeight).lineTo(PAGE.left + gridWidth, y + row * cellHeight).lineWidth(0.5).strokeColor(COLOR.border).stroke()
  }
  doc.moveTo(PAGE.left + gridWidth / 2, y).lineTo(PAGE.left + gridWidth / 2, y + boxHeight).lineWidth(0.5).strokeColor(COLOR.border).stroke()
  if (data.photo) {
    doc.moveTo(PAGE.left + gridWidth, y).lineTo(PAGE.left + gridWidth, y + boxHeight).lineWidth(0.5).strokeColor(COLOR.border).stroke()
    try {
      const inset = 6
      doc.image(data.photo, PAGE.left + gridWidth + inset, y + inset, {
        fit: [photoWidth - inset * 2, boxHeight - inset * 2],
        align: 'center',
        valign: 'center',
      })
    } catch (error) {
      logger.warn({ err: error }, 'The employee photo is not a drawable image')
    }
  }
  doc.lineWidth(1)
  y += boxHeight + 10

  // --- Attendance --------------------------------------------------------------
  const attendance: [string, string][] = [
    ['Days in period', String(Number(item.calendar_days))],
    ['Paid days', String(Number(item.paid_days))],
    ['Present', String(Number(item.present_days))],
    ['Absent', String(Number(item.absent_days))],
    ['Leave', String(Number(item.leave_days))],
    ['Holidays / offs', String(Number(item.holiday_days) + Number(item.weekly_off_days))],
  ]
  const stripHeight = 38
  doc.rect(PAGE.left, y, PAGE.width, stripHeight).fill(COLOR.tint)
  const stripWidth = PAGE.width / attendance.length
  attendance.forEach(([label, value], index) => {
    const x = PAGE.left + index * stripWidth
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted).text(label.toUpperCase(), x + 8, y + 7, { width: stripWidth - 12, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.accent).text(value, x + 8, y + 19, { width: stripWidth - 12, lineBreak: false })
  })
  y += stripHeight + 14

  // --- Earnings and deductions -----------------------------------------------
  const earnings = components.filter((component) => component.component_type === 'EARNING')
  const deductions = components.filter((component) => component.component_type === 'DEDUCTION')
  const employer = components.filter((component) => component.component_type === 'EMPLOYER_CONTRIBUTION')

  const toRow = (component: PayrollItemComponentRow): TableRow => ({
    name: component.component_name,
    // Only pay lines that need explaining carry their note (e.g. which holiday was worked).
    note: component.source === 'HOLIDAY_WORK' || component.source === 'OVERTIME' ? component.notes : null,
    amount: money(component.amount),
  })
  const earningRows = earnings.map(toRow)
  const deductionRows = deductions.map(toRow)
  const tableHeight = (rows: TableRow[]): number =>
    20 + Math.max(rows.length, 1) * ROW_HEIGHT + rows.filter((row) => row.note).length * NOTE_HEIGHT
  const needed = Math.max(tableHeight(earningRows), tableHeight(deductionRows)) + 26 + 80
  y = ensureSpace(doc, y, needed)

  const leftEnd = drawSide(doc, PAGE.left, y, 'Earnings', earningRows)
  const rightEnd = drawSide(doc, PAGE.left + HALF + 15, y, 'Deductions', deductionRows)
  const totalsY = Math.max(leftEnd, rightEnd)

  const total = (x: number, label: string, value: string): void => {
    doc.rect(x, totalsY, HALF, 22).fill(COLOR.band)
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.ink).text(label, x + 8, totalsY + 7, { width: HALF - 108, lineBreak: false })
    doc.text(value, x + HALF - 92, totalsY + 7, { width: 84, align: 'right', lineBreak: false })
  }
  total(PAGE.left, 'Gross earnings', money(item.gross_earnings))
  total(PAGE.left + HALF + 15, 'Total deductions', money(item.total_deductions))
  y = totalsY + 22 + 14

  // --- Net pay -----------------------------------------------------------------
  const net = Number(item.net_salary)
  doc.rect(PAGE.left, y, PAGE.width, 54).lineWidth(1).fillAndStroke(COLOR.tint, COLOR.accent)
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.accent).text('NET PAY (INR)', PAGE.left + 12, y + 9, { lineBreak: false })
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted).text('Gross earnings less total deductions', PAGE.left + 12, y + 21, { lineBreak: false })
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR.ink).text(amountInWords(net), PAGE.left + 12, y + 35, {
    width: PAGE.width - 24,
    lineBreak: false,
    ellipsis: true,
  })
  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLOR.accent).text(money(net), PAGE.left + PAGE.width - 230, y + 9, {
    width: 218,
    align: 'right',
    lineBreak: false,
  })
  y += 54 + 14

  // --- Employer contributions ----------------------------------------------------
  if (employer.length > 0) {
    y = ensureSpace(doc, y, 30 + Math.ceil(employer.length / 2) * 16)
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.accent).text('EMPLOYER CONTRIBUTIONS', PAGE.left, y, { lineBreak: false })
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted).text('Paid by the employer in addition to the salary; not deducted from net pay.', PAGE.left + 130, y + 0.5, { lineBreak: false })
    y += 14
    employer.forEach((component, index) => {
      const x = PAGE.left + (index % 2) * (HALF + 15)
      const rowY = y + Math.floor(index / 2) * 16
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.ink).text(component.component_name, x + 8, rowY, { width: HALF - 108, lineBreak: false, ellipsis: true })
      doc.text(money(component.amount), x + HALF - 92, rowY, { width: 84, align: 'right', lineBreak: false })
    })
    y += Math.ceil(employer.length / 2) * 16 + 8
  }

  // --- Payment details ----------------------------------------------------------------
  const payments = data.payments
  y = ensureSpace(doc, y, 20 + Math.max(payments.length, 0) * 13 + 20)
  const status = String(item.payment_status).replace(/_/g, ' ')
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.accent).text('PAYMENT DETAILS', PAGE.left, y, { lineBreak: false })
  y += 12
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted)
  doc.text(`Status: ${status}     Paid: ${money(item.paid_amount)}     Pending: ${money(item.pending_amount)}`, PAGE.left, y, { lineBreak: false })
  y += 13
  for (const payment of payments) {
    const line = `${shortDate(payment.date)}   ${money(payment.amount)}   ${payment.method.replace(/_/g, ' ')}${payment.reference ? `   Ref: ${payment.reference}` : ''}`
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.ink).text(line, PAGE.left, y, { lineBreak: false })
    y += 13
  }
  y += 6

  // --- Statutory citation --------------------------------------------------------------
  y = ensureSpace(doc, y, 14)
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.faint)
  doc.text('[See Rule 78(1)(b) of the Contract Labour (Regulation and Abolition) Central Rules, 1971]', PAGE.left, y, { lineBreak: false })

  drawFooter(doc, 'This is a computer generated payslip and does not require a signature.', `Generated ${longDate(data.generatedOn)}`)
}

/** A payslip as a standalone PDF (the copy stored when a run's payslips are generated). */
export function renderPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  return buildPdf(`Payslip ${data.item.employee_code}`, (doc) => drawPayslipPage(doc, data))
}
