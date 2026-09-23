import {
  buildPdf,
  COLOR,
  drawFooter,
  drawLetterhead,
  longDate,
  PAGE,
  type Letterhead,
  type Pdf,
} from '../../utils/pdf.js'

/**
 * A No Objection Certificate: an employment confirmation with a "no objection"
 * statement, issued on the organization's letterhead. It carries no pay figures
 * and is not tied to any month.
 */

export interface NocData {
  letterhead: Letterhead
  employeeName: string
  employeeCode: string
  /** The employee's designation, which the organization calls their section. */
  designation: string | null
  department: string | null
  joiningDate: string
  exitDate: string | null
  /** Still on the rolls (active or serving notice), which decides the tense. */
  isCurrent: boolean
  /** What the employee asked for the certificate for; optional. */
  purpose: string | null
  issuedOn: string
}

function body(doc: Pdf, text: string, y: number): number {
  doc.font('Helvetica').fontSize(11).fillColor(COLOR.ink).text(text, PAGE.left, y, {
    width: PAGE.width,
    align: 'justify',
    lineGap: 4,
  })
  return doc.y
}

export function drawNoc(doc: Pdf, data: NocData): void {
  let y = drawLetterhead(doc, data.letterhead) + 34

  // --- Title ---------------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR.accent).text('NO OBJECTION CERTIFICATE', PAGE.left, y, {
    width: PAGE.width,
    align: 'center',
    characterSpacing: 0.6,
  })
  y = doc.y + 4
  doc.moveTo(PAGE.left + 170, y).lineTo(PAGE.right - 170, y).lineWidth(1).strokeColor(COLOR.accent).stroke()
  y += 22

  // --- Reference and date --------------------------------------------------------
  const ref = `NOC/${data.employeeCode}/${data.issuedOn.replace(/-/g, '')}`
  doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.muted)
  doc.text(`Ref. No: ${ref}`, PAGE.left, y, { width: PAGE.width / 2, lineBreak: false })
  doc.text(`Date: ${longDate(data.issuedOn)}`, PAGE.left + PAGE.width / 2, y, { width: PAGE.width / 2, align: 'right', lineBreak: false })
  y += 34

  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.ink).text('TO WHOMSOEVER IT MAY CONCERN', PAGE.left, y, { lineBreak: false })
  y += 28

  // --- Employment statement --------------------------------------------------------
  // The organization calls a designation a "section" throughout the application.
  const role = [
    data.designation ? `in the ${data.designation} section` : '',
    data.department ? `${data.designation ? 'of' : 'in'} the ${data.department} department` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const tenure = data.isCurrent
    ? `since ${longDate(data.joiningDate)}`
    : data.exitDate
      ? `from ${longDate(data.joiningDate)} to ${longDate(data.exitDate)}`
      : `from ${longDate(data.joiningDate)}`
  y = body(
    doc,
    `This is to certify that ${data.employeeName} (Employee ID: ${data.employeeCode}) ${data.isCurrent ? 'is' : 'was'} ${
      data.isCurrent ? 'working' : 'employed'
    } with ${data.letterhead.name}${role ? ` ${role}` : ''} ${tenure}.`,
    y,
  )
  y += 16

  // --- Employee particulars ----------------------------------------------------------
  const rows: [string, string][] = [
    ['Employee name', data.employeeName],
    ['Employee ID', data.employeeCode],
    ['Section', data.designation ?? '-'],
    ['Department', data.department ?? '-'],
    ['Date of joining', longDate(data.joiningDate)],
  ]
  if (!data.isCurrent && data.exitDate) rows.push(['Date of leaving', longDate(data.exitDate)])

  const rowHeight = 24
  const tableTop = y
  doc.rect(PAGE.left, tableTop, PAGE.width, rows.length * rowHeight).lineWidth(0.75).strokeColor(COLOR.border).stroke()
  rows.forEach(([label, value], index) => {
    const rowY = tableTop + index * rowHeight
    if (index % 2 === 0) doc.rect(PAGE.left + 0.4, rowY + 0.4, PAGE.width - 0.8, rowHeight - 0.8).fill(COLOR.band)
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.muted).text(label, PAGE.left + 12, rowY + 7.5, { width: 150, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLOR.ink).text(value, PAGE.left + 170, rowY + 7, { width: PAGE.width - 182, lineBreak: false, ellipsis: true })
  })
  y = tableTop + rows.length * rowHeight + 22

  // --- No objection ------------------------------------------------------------------
  y = body(
    doc,
    data.purpose
      ? `This certificate is issued at the request of the employee for the purpose of ${data.purpose}. The Company has no objection to the same.`
      : 'This certificate is issued at the request of the employee. The Company has no objection in this regard.',
    y,
  )
  y += 12
  y = body(doc, 'This certificate is issued without any liability or obligation on the part of the Company.', y)

  // --- Signature -----------------------------------------------------------------------
  const signatureTop = Math.max(y + 70, 560)
  const blockX = PAGE.right - 200
  doc.font('Helvetica').fontSize(10).fillColor(COLOR.ink).text(`For ${data.letterhead.name}`, blockX, signatureTop, { width: 200, align: 'right', lineBreak: false })
  const lineY = signatureTop + 66
  doc.moveTo(blockX, lineY).lineTo(PAGE.right, lineY).lineWidth(0.75).strokeColor(COLOR.ink).stroke()
  doc.font('Helvetica-Bold').fontSize(10).text('Authorised Signatory', blockX, lineY + 6, { width: 200, align: 'right', lineBreak: false })
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted).text('Company seal', PAGE.left, lineY + 6, { lineBreak: false })

  drawFooter(doc, 'Issued on the basis of the Company\'s employment records.')
}

export function renderNocPdf(data: NocData): Promise<Buffer> {
  return buildPdf(`No Objection Certificate ${data.employeeCode}`, (doc) => drawNoc(doc, data))
}
