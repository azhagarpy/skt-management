import PDFDocument from 'pdfkit'
import { pool, queryOne, type Queryable } from '../database/pool.js'
import { storage } from '../modules/documents/storage.service.js'
import { logger } from './logger.js'

/**
 * Shared building blocks for the generated PDFs (payslips, certificates).
 *
 * pdfkit's built-in fonts have no rupee sign, so amounts are printed as plain
 * numbers under an "INR" heading rather than with a symbol that would come out
 * garbled.
 */

export type Pdf = InstanceType<typeof PDFDocument>

export const PAGE = { left: 40, width: 515, right: 555, bottom: 780 } as const

export const COLOR = {
  ink: '#111827',
  muted: '#6b7280',
  faint: '#9ca3af',
  accent: '#1f3a5f',
  border: '#d1d5db',
  band: '#f3f4f6',
  tint: '#eef3fa',
} as const

/** Runs `build` against a fresh A4 document and resolves with the finished PDF. */
export function buildPdf(title: string, build: (doc: Pdf) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: title, Producer: 'Payroll' },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    try {
      build(doc)
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? String(month)
}

/** "2026-08-15" -> "15 August 2026". */
export function longDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-')
  return `${Number(day)} ${monthName(Number(month))} ${year}`
}

/** "2026-08-15" -> "15 Aug 2026". */
export function shortDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-')
  return `${Number(day)} ${monthName(Number(month)).slice(0, 3)} ${year}`
}

const numberFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 15623 -> "15,623.00" (Indian digit grouping, no currency symbol). */
export function money(value: string | number): string {
  return numberFormat.format(Number(value))
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] as string
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ')
}

/** Whole number in the Indian system (thousand, lakh, crore). */
function indianWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const rest = n % 1000
  if (crore) parts.push(`${indianWords(crore)} Crore`)
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`)
  if (rest) parts.push(belowThousand(rest))
  return parts.join(' ')
}

/** 15623.08 -> "Rupees Fifteen Thousand Six Hundred Twenty Three and Eight Paise Only". */
export function amountInWords(amount: number): string {
  const negative = amount < 0
  const total = Math.round(Math.abs(amount) * 100)
  const rupees = Math.floor(total / 100)
  const paise = total % 100
  const words = `Rupees ${indianWords(rupees)}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`
  return negative ? `Minus ${words}` : words
}

// ---------------------------------------------------------------------------
// Letterhead
// ---------------------------------------------------------------------------

export interface Letterhead {
  /** The name to print: the registered (legal) name when there is one. */
  name: string
  addressLines: string[]
  contactLine: string
  identifiers: string[]
  city: string | null
  logo: Buffer | null
}

interface OrganizationRow {
  name: string
  legal_name: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  pincode: string | null
  phone: string | null
  email: string | null
  website: string | null
  tax_id: string | null
  registration_no: string | null
  logo_path: string | null
}

export async function loadLetterhead(organizationId: string, db: Queryable = pool): Promise<Letterhead> {
  const row = await queryOne<OrganizationRow>(
    db,
    `SELECT name, legal_name, address_line1, address_line2, city, state, pincode, phone, email, website,
            tax_id, registration_no, logo_path
       FROM organizations WHERE id = $1`,
    [organizationId],
  )
  if (!row) throw new Error('Organization not found')

  let logo: Buffer | null = null
  if (row.logo_path) {
    // A missing or unreadable logo must never stop a document being produced.
    try {
      logo = await storage.get(row.logo_path)
    } catch (error) {
      logger.warn({ err: error }, 'Could not load the organization logo for a PDF')
    }
  }

  const cityLine = [row.city, [row.state, row.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return {
    name: row.legal_name?.trim() || row.name,
    addressLines: [[row.address_line1, row.address_line2].filter(Boolean).join(', '), cityLine].filter(Boolean),
    contactLine: [row.phone, row.email, row.website].filter(Boolean).join('   |   '),
    identifiers: [row.registration_no ? `Reg. No: ${row.registration_no}` : '', row.tax_id ? `Tax ID: ${row.tax_id}` : ''].filter(Boolean),
    city: row.city,
    logo,
  }
}

/** Logo (if any) beside the organization's name and address, then a rule. Returns the y below it. */
export function drawLetterhead(doc: Pdf, letterhead: Letterhead): number {
  const top = 36
  const logoSize = 56
  let textX: number = PAGE.left
  let logoDrawn = false

  if (letterhead.logo) {
    try {
      doc.image(letterhead.logo, PAGE.left, top, { fit: [logoSize, logoSize] })
      textX = PAGE.left + logoSize + 14
      logoDrawn = true
    } catch (error) {
      logger.warn({ err: error }, 'The organization logo is not a drawable image')
    }
  }

  const textWidth = PAGE.right - textX
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR.accent).text(letterhead.name, textX, top, { width: textWidth })
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted)
  for (const line of [...letterhead.addressLines, letterhead.contactLine, ...letterhead.identifiers]) {
    if (line) doc.text(line, textX, doc.y + 1, { width: textWidth })
  }

  const bottom = Math.max(doc.y, logoDrawn ? top + logoSize : 0) + 8
  doc.moveTo(PAGE.left, bottom).lineTo(PAGE.right, bottom).lineWidth(1.5).strokeColor(COLOR.accent).stroke()
  doc.lineWidth(1)
  return bottom
}

/** Starts a new page when fewer than `needed` points remain above the footer. Returns the y to continue from. */
export function ensureSpace(doc: Pdf, y: number, needed: number): number {
  if (y + needed <= PAGE.bottom - 20) return y
  doc.addPage()
  return 40
}

/** A small grey note pinned to the foot of the current page. */
export function drawFooter(doc: Pdf, text: string, right?: string): void {
  const y = PAGE.bottom - 4
  doc.moveTo(PAGE.left, y - 6).lineTo(PAGE.right, y - 6).lineWidth(0.5).strokeColor(COLOR.border).stroke()
  doc.lineWidth(1)
  // Text this low would trip pdfkit's automatic page break, so the margin is lifted while it is written.
  const bottomMargin = doc.page.margins.bottom
  doc.page.margins.bottom = 0
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.faint)
  doc.text(text, PAGE.left, y, { width: right ? PAGE.width * 0.7 : PAGE.width, align: right ? 'left' : 'center', lineBreak: false })
  if (right) doc.text(right, PAGE.left + PAGE.width * 0.7, y, { width: PAGE.width * 0.3, align: 'right', lineBreak: false })
  doc.page.margins.bottom = bottomMargin
}
