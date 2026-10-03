import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { normaliseDate } from '../../utils/dates.js'
import type { ReportColumn, ReportDefinition } from './report-definitions.js'

/**
 * Report exporters (plan section 57): CSV, Excel and PDF from the same rows.
 */

export interface ExportPayload {
  definition: ReportDefinition
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  organizationName: string
  currencyCode: string
  generatedAt: Date
  filterSummary: string
}

function formatValue(value: unknown, format: ReportColumn['format']): string {
  if (value === null || value === undefined || value === '') return ''

  switch (format) {
    case 'date':
      return normaliseDate(value as string | Date) ?? ''
    case 'currency':
    case 'number':
    case 'days':
    case 'percent': {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) return String(value)
      return format === 'number' ? String(numeric) : numeric.toFixed(2)
    }
    default:
      return String(value)
  }
}

/** Escapes a value for CSV, guarding against formula injection in spreadsheets. */
function csvCell(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value)
  const escaped = dangerous ? `'${value}` : value
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`
  }
  return escaped
}

export function toCsv(payload: ExportPayload): Buffer {
  const { definition, rows, totals } = payload
  const lines: string[] = []

  lines.push(definition.columns.map((column) => csvCell(column.label)).join(','))

  for (const row of rows) {
    lines.push(
      definition.columns.map((column) => csvCell(formatValue(row[column.key], column.format))).join(','),
    )
  }

  const hasTotals = definition.columns.some((column) => column.total)
  if (hasTotals && rows.length > 0) {
    lines.push(
      definition.columns
        .map((column, index) => {
          if (index === 0 && !column.total) return csvCell('Total')
          if (!column.total) return ''
          return csvCell(formatValue(totals[column.key], column.format))
        })
        .join(','),
    )
  }

  // A BOM keeps Excel happy with UTF-8 on Windows.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}

export async function toExcel(payload: ExportPayload): Promise<Buffer> {
  const { definition, rows, totals, organizationName, generatedAt, filterSummary } = payload

  const workbook = new ExcelJS.Workbook()
  workbook.creator = organizationName
  workbook.created = generatedAt

  const sheet = workbook.addWorksheet(definition.name.slice(0, 31))

  sheet.addRow([organizationName])
  sheet.getRow(1).font = { bold: true, size: 14 }
  sheet.addRow([definition.name])
  sheet.getRow(2).font = { bold: true, size: 12 }
  if (filterSummary) sheet.addRow([filterSummary])
  sheet.addRow([`Generated ${generatedAt.toISOString()}`])
  sheet.addRow([])

  const headerRow = sheet.addRow(definition.columns.map((column) => column.label))
  headerRow.font = { bold: true }
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } }
  })

  for (const row of rows) {
    const values = definition.columns.map((column) => {
      const value = row[column.key]
      if (value === null || value === undefined) return ''
      if (column.format === 'currency' || column.format === 'days' || column.format === 'percent') {
        const numeric = Number(value)
        return Number.isFinite(numeric) ? numeric : value
      }
      if (column.format === 'number') {
        const numeric = Number(value)
        return Number.isFinite(numeric) ? numeric : value
      }
      if (column.format === 'date') return normaliseDate(value as string | Date) ?? ''
      return String(value)
    })
    sheet.addRow(values)
  }

  if (definition.columns.some((column) => column.total) && rows.length > 0) {
    const totalRow = sheet.addRow(
      definition.columns.map((column, index) => {
        if (index === 0 && !column.total) return 'Total'
        if (!column.total) return ''
        return totals[column.key] ?? 0
      }),
    )
    totalRow.font = { bold: true }
  }

  definition.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1)
    sheetColumn.width = Math.max(column.label.length + 4, 14)
    if (column.format === 'currency') sheetColumn.numFmt = '#,##0.00'
    if (column.format === 'days') sheetColumn.numFmt = '0.00'
  })

  sheet.views = [{ state: 'frozen', ySplit: 6 }]

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

const PDF_MARGIN = 30
const CELL_PAD_X = 3
const CELL_PAD_Y = 3
const PDF_FONT_SIZES = [7.5, 7, 6.5, 6]

function isNumericFormat(format: ReportColumn['format']): boolean {
  return format === 'currency' || format === 'number' || format === 'days' || format === 'percent'
}

type PdfDoc = InstanceType<typeof PDFDocument>

/**
 * Column widths sized to the content: every column gets at least its longest
 * word (numbers never wrap), and whatever room is left goes to the columns
 * whose full text would otherwise wrap. Falls back to a smaller type size
 * when even the unwrappable minimum will not fit across the page.
 */
function layoutColumns(
  doc: PdfDoc,
  columns: ReportColumn[],
  cells: string[][],
  pageWidth: number,
): { widths: number[]; fontSize: number } {
  // pdfkit measures a word together with the space after it when wrapping, so
  // the space is counted here too or the word gets split mid-way.
  const longestWord = (text: string): number =>
    Math.max(0, ...text.split(/\s+/).filter(Boolean).map((word) => doc.widthOfString(`${word} `)))

  let chosen: { widths: number[]; fontSize: number } | null = null
  for (const fontSize of PDF_FONT_SIZES) {
    const natural: number[] = []
    const minimum: number[] = []

    columns.forEach((column, index) => {
      doc.font('Helvetica-Bold').fontSize(fontSize)
      const headerWord = longestWord(column.label)
      doc.font('Helvetica').fontSize(fontSize)
      let full = 0
      let word = 0
      for (const row of cells) {
        const text = row[index] ?? ''
        if (!text) continue
        full = Math.max(full, doc.widthOfString(text))
        if (!isNumericFormat(column.format)) word = Math.max(word, longestWord(text))
      }
      const pad = CELL_PAD_X * 2 + 1
      const min = Math.max(headerWord, isNumericFormat(column.format) ? full : word) + pad
      minimum.push(min)
      natural.push(Math.max(min, full + pad))
    })

    const sumMin = minimum.reduce((a, b) => a + b, 0)
    const sumNatural = natural.reduce((a, b) => a + b, 0)
    let widths: number[]
    if (sumNatural <= pageWidth) {
      // Everything fits on one line; share the spare room out evenly.
      const spare = (pageWidth - sumNatural) / columns.length
      widths = natural.map((width) => width + spare)
    } else if (sumMin <= pageWidth) {
      const ratio = (pageWidth - sumMin) / (sumNatural - sumMin)
      widths = minimum.map((min, index) => min + ((natural[index] ?? min) - min) * ratio)
    } else {
      // Even the minimum overflows: scale down and let pdfkit break long words.
      widths = minimum.map((min) => (min / sumMin) * pageWidth)
    }

    chosen = { widths, fontSize }
    if (sumMin <= pageWidth) break
  }

  return chosen as { widths: number[]; fontSize: number }
}

export function toPdf(payload: ExportPayload): Promise<Buffer> {
  const { definition, rows, totals, organizationName, generatedAt, filterSummary } = payload
  const columns = definition.columns

  return new Promise((resolve, reject) => {
    // Landscape gives wide reports room without shrinking the type.
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PDF_MARGIN, bufferPages: true })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = PDF_MARGIN
    const pageWidth = doc.page.width - PDF_MARGIN * 2
    const bottom = doc.page.height - PDF_MARGIN - 14

    const cells = rows.map((row) => columns.map((column) => formatValue(row[column.key], column.format)))
    const hasTotals = columns.some((column) => column.total) && rows.length > 0
    const totalCells = hasTotals
      ? columns.map((column, index) =>
          index === 0 && !column.total ? 'Total' : column.total ? formatValue(totals[column.key], column.format) : '',
        )
      : null

    const { widths, fontSize } = layoutColumns(doc, columns, totalCells ? [...cells, totalCells] : cells, pageWidth)
    const xs = widths.reduce<number[]>((acc, _width, index) => {
      acc.push(index === 0 ? left : (acc[index - 1] ?? left) + (widths[index - 1] ?? 0))
      return acc
    }, [])

    const rowHeight = (values: string[], font: string): number => {
      doc.font(font).fontSize(fontSize)
      let tallest = 0
      values.forEach((text, index) => {
        const width = (widths[index] ?? 0) - CELL_PAD_X * 2
        if (text) tallest = Math.max(tallest, doc.heightOfString(text, { width }))
      })
      return Math.max(tallest, fontSize * 1.2) + CELL_PAD_Y * 2
    }

    const drawRow = (values: string[], y: number, height: number, font: string, color: string, fill?: string): void => {
      if (fill) doc.rect(left, y, pageWidth, height).fill(fill)
      doc.font(font).fontSize(fontSize).fillColor(color)
      values.forEach((text, index) => {
        if (!text) return
        const column = columns[index]
        doc.text(text, (xs[index] ?? left) + CELL_PAD_X, y + CELL_PAD_Y, {
          width: (widths[index] ?? 0) - CELL_PAD_X * 2,
          align: column && isNumericFormat(column.format) ? 'right' : 'left',
          lineGap: 0,
        })
      })
      doc
        .moveTo(left, y + height)
        .lineTo(left + pageWidth, y + height)
        .lineWidth(0.4)
        .strokeColor('#d9dde3')
        .stroke()
    }

    const headerLabels = columns.map((column) => column.label)
    const headerHeight = rowHeight(headerLabels, 'Helvetica-Bold')

    const drawPageHeader = (): number => {
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000').text(organizationName, left, PDF_MARGIN)
      doc.font('Helvetica').fontSize(10).text(definition.name, left)
      doc.fontSize(7.5).fillColor('#666666')
      if (filterSummary) doc.text(filterSummary, left)
      doc.text(`Generated ${generatedAt.toISOString()}`, left)
      const y = doc.y + 6
      drawRow(headerLabels, y, headerHeight, 'Helvetica-Bold', '#000000', '#eef1f5')
      return y + headerHeight
    }

    let y = drawPageHeader()
    cells.forEach((values, index) => {
      const height = rowHeight(values, 'Helvetica')
      if (y + height > bottom) {
        doc.addPage()
        y = drawPageHeader()
      }
      drawRow(values, y, height, 'Helvetica', '#222222', index % 2 === 1 ? '#f8f9fb' : undefined)
      y += height
    })

    if (totalCells) {
      const height = rowHeight(totalCells, 'Helvetica-Bold')
      if (y + height > bottom) {
        doc.addPage()
        y = drawPageHeader()
      }
      doc.moveTo(left, y).lineTo(left + pageWidth, y).lineWidth(0.8).strokeColor('#9aa3ad').stroke()
      drawRow(totalCells, y, height, 'Helvetica-Bold', '#000000', '#eef1f5')
    }

    // Page numbers, written once every page exists.
    const range = doc.bufferedPageRange()
    for (let page = range.start; page < range.start + range.count; page += 1) {
      doc.switchToPage(page)
      const bottomMargin = doc.page.margins.bottom
      doc.page.margins.bottom = 0
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#888888')
        .text(`Page ${page - range.start + 1} of ${range.count}`, left, doc.page.height - PDF_MARGIN - 6, {
          width: pageWidth,
          align: 'right',
          lineBreak: false,
        })
      doc.page.margins.bottom = bottomMargin
    }

    doc.end()
  })
}

const ECR_SEPARATOR = '#~#'

/** Whole rupees, as the PF portal expects; never negative, never fractional. */
function ecrAmount(value: unknown): string {
  const numeric = Number(value ?? 0)
  return String(Number.isFinite(numeric) ? Math.max(Math.round(numeric), 0) : 0)
}

/**
 * The PF ECR upload text (PF report only): one line per member, no header,
 * fields joined by "#~#".
 *
 *   UAN # name # gross wages # EPF wages # EPS wages # EDLI wages
 *       # EPF contribution (employee) # EPS contribution # EPF-EPS difference (employer)
 *       # days not worked # refund of advances
 *
 * The three wage columns carry the PF-covered wage, except that a member outside
 * the Pension Scheme (`pension_applicable` 0) has EPS wages of 0 - their whole
 * employer share is in the EPF column. Anyone without a UAN or member number, or
 * not marked PF-applicable, is left out because the portal would reject the
 * row; `skipped` reports how many so the caller can say so.
 */
export function toPfEcr(rows: Record<string, unknown>[]): { buffer: Buffer; included: number; skipped: number } {
  const lines: string[] = []
  let skipped = 0

  for (const row of rows) {
    const memberNumber = String(row.ecr_member_number ?? '').trim()
    if (!memberNumber || row.ecr_pf_applicable === false) {
      skipped += 1
      continue
    }

    // A name containing the separator or a line break would corrupt the row.
    const name = String(row.pf_name ?? '')
      .replace(/#~#/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .trim()
    const pfWage = ecrAmount(row.pf_covered_amount)
    const pensionMember = row.pension_applicable === undefined || Number(row.pension_applicable) !== 0

    lines.push(
      [
        memberNumber,
        name,
        ecrAmount(row.total_wages),
        pfWage,
        pensionMember ? pfWage : '0',
        pfWage,
        ecrAmount(row.employee_contribution),
        ecrAmount(row.employer_eps),
        ecrAmount(row.employer_epf),
        String(Math.max(Math.round(Number(row.ecr_ncp_days ?? 0)), 0)),
        '0',
      ].join(ECR_SEPARATOR),
    )
  }

  const text = lines.length > 0 ? `${lines.join('\r\n')}\r\n` : ''
  return { buffer: Buffer.from(text, 'utf8'), included: lines.length, skipped }
}

export function describeFilters(filters: Record<string, unknown>): string {
  const parts: string[] = []
  const labels: Record<string, string> = {
    from: 'From',
    to: 'To',
    year: 'Year',
    month: 'Month',
    fromMonth: 'From month',
    toMonth: 'To month',
    departmentId: 'Department',
    supervisorId: 'Supervisor',
    employeeId: 'Employee',
    locationId: 'Location',
    employmentStatus: 'Employment status',
    attendanceStatus: 'Attendance status',
    leaveStatus: 'Leave status',
    paymentStatus: 'Payment status',
  }

  for (const [key, label] of Object.entries(labels)) {
    const value = filters[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${label}: ${String(value)}`)
  }

  return parts.join('   ')
}
