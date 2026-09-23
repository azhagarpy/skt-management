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
          if (index === 0) return csvCell('Total')
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
        if (index === 0) return 'Total'
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

export function toPdf(payload: ExportPayload): Promise<Buffer> {
  const { definition, rows, totals, organizationName, generatedAt, filterSummary } = payload

  return new Promise((resolve, reject) => {
    // Landscape gives wide reports room without shrinking the type.
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const pageWidth = doc.page.width - 72
    const columnWidth = pageWidth / definition.columns.length

    const drawHeader = (): void => {
      doc.fontSize(14).fillColor('#000000').text(organizationName, { align: 'left' })
      doc.fontSize(11).text(definition.name)
      doc.fontSize(8).fillColor('#666666')
      if (filterSummary) doc.text(filterSummary)
      doc.text(`Generated ${generatedAt.toISOString()}`)
      doc.moveDown(0.5)

      const y = doc.y
      doc.fontSize(8).fillColor('#000000')
      definition.columns.forEach((column, index) => {
        doc.text(column.label, 36 + index * columnWidth, y, { width: columnWidth - 4, ellipsis: true })
      })
      doc
        .moveTo(36, y + 12)
        .lineTo(36 + pageWidth, y + 12)
        .strokeColor('#cccccc')
        .stroke()
      doc.y = y + 18
    }

    drawHeader()
    doc.fontSize(8).fillColor('#333333')

    for (const row of rows) {
      // Start a new page before the row would overflow the bottom margin.
      if (doc.y > doc.page.height - 60) {
        doc.addPage()
        drawHeader()
        doc.fontSize(8).fillColor('#333333')
      }

      const y = doc.y
      definition.columns.forEach((column, index) => {
        doc.text(formatValue(row[column.key], column.format), 36 + index * columnWidth, y, {
          width: columnWidth - 4,
          ellipsis: true,
        })
      })
      doc.y = y + 14
    }

    if (definition.columns.some((column) => column.total) && rows.length > 0) {
      const y = doc.y + 4
      doc.moveTo(36, y - 2).lineTo(36 + pageWidth, y - 2).strokeColor('#cccccc').stroke()
      doc.fontSize(8).fillColor('#000000')
      definition.columns.forEach((column, index) => {
        const text = index === 0 ? 'Total' : column.total ? formatValue(totals[column.key], column.format) : ''
        doc.text(text, 36 + index * columnWidth, y + 4, { width: columnWidth - 4, ellipsis: true })
      })
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
 * The three wage columns all carry the PF-covered wage. Anyone without a UAN or
 * member number, or not marked PF-applicable, is left out because the portal
 * would reject the row; `skipped` reports how many so the caller can say so.
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

    lines.push(
      [
        memberNumber,
        name,
        ecrAmount(row.total_wages),
        pfWage,
        pfWage,
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
