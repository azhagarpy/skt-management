import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import { pool, queryOne } from '../../database/pool.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './reports.service.js'
import { ApiError } from '../../utils/api-error.js'
import { describeFilters, toCsv, toExcel, toPdf, toPfEcr, type ExportPayload } from './report-exporters.js'

const keyParam = z.object({ key: z.string().trim().min(2).max(60) })

export const reportRouter = Router()
reportRouter.use(authenticate)

const canView = requireAnyPermission(PERMISSIONS.REPORT_VIEW_ALL, PERMISSIONS.REPORT_VIEW_TEAM)

/** The catalogue, so the client can render filters without hard-coding them. */
reportRouter.get(
  '/',
  canView,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, service.listReports(auth))
  }),
)

reportRouter.get(
  '/:key',
  canView,
  validate({ params: keyParam, query: service.reportFilterSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const result = await service.runReport(auth, req.params.key as string, req.query as unknown as service.ReportFilters)
    return sendSuccess(res, result.rows, undefined, 200, {
      key: result.key,
      name: result.name,
      columns: result.columns,
      totals: result.totals,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

/**
 * Exports a report as CSV, Excel or PDF. The file is streamed as an attachment;
 * exporting is itself an audited action because reports carry salary data.
 */
reportRouter.get(
  '/:key/export',
  requirePermissions(PERMISSIONS.REPORT_EXPORT),
  validate({ params: keyParam, query: service.exportQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const key = req.params.key as string
    const query = req.query as unknown as service.ExportQuery

    if (query.format === 'ecr' && key !== 'pf-report') {
      throw ApiError.badRequest('The ECR text format is only available for the PF report')
    }

    const { definition, rows, totals } = await service.runReportForExport(auth, key, query)

    const organization = await queryOne<{ name: string; currency_code: string }>(
      pool,
      'SELECT name, currency_code FROM organizations WHERE id = $1',
      [auth.organizationId],
    )

    const payload: ExportPayload = {
      definition,
      rows,
      totals,
      organizationName: organization?.name ?? 'Organization',
      currencyCode: organization?.currency_code ?? 'INR',
      generatedAt: new Date(),
      filterSummary: describeFilters(query as unknown as Record<string, unknown>),
    }

    let buffer: Buffer
    let mimeType: string
    let extension: string

    let ecrSummary: { included: number; skipped: number } | null = null

    if (query.format === 'ecr') {
      const ecr = toPfEcr(rows)
      buffer = ecr.buffer
      ecrSummary = { included: ecr.included, skipped: ecr.skipped }
      mimeType = 'text/plain; charset=utf-8'
      extension = 'txt'
    } else if (query.format === 'xlsx') {
      buffer = await toExcel(payload)
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      extension = 'xlsx'
    } else if (query.format === 'pdf') {
      buffer = await toPdf(payload)
      mimeType = 'application/pdf'
      extension = 'pdf'
    } else {
      buffer = toCsv(payload)
      mimeType = 'text/csv; charset=utf-8'
      extension = 'csv'
    }

    await recordAudit({
      ...auditContextFrom(req),
      action: 'REPORT_EXPORTED',
      entityType: 'report',
      entityId: null,
      newValues: { report: key, format: query.format, rows: ecrSummary?.included ?? rows.length, ...(ecrSummary ? { skipped: ecrSummary.skipped } : {}) },
    })

    const period = query.year && query.month ? `${query.year}-${String(query.month).padStart(2, '0')}` : new Date().toISOString().slice(0, 10)
    const filename = `${query.format === 'ecr' ? 'pf-ecr' : definition.key}-${period}.${extension}`
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    if (ecrSummary) {
      // Lets the screen tell the user how many members had no UAN and were left out.
      res.setHeader('X-Export-Skipped', String(ecrSummary.skipped))
      res.setHeader('Access-Control-Expose-Headers', 'X-Export-Skipped, Content-Disposition')
    }
    res.send(buffer)
  }),
)
