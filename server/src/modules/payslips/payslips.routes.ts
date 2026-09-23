import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './payslips.service.js'

export const payslipRouter = Router()
payslipRouter.use(authenticate)

const canView = requireAnyPermission(PERMISSIONS.PAYSLIP_VIEW_ALL, PERMISSIONS.PAYSLIP_VIEW_SELF)

payslipRouter.get(
  '/',
  canView,
  validate({ query: z.object({ employeeId: z.union([z.literal('me'), z.string().uuid()]).optional() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const requested = (req.query as { employeeId?: string }).employeeId
    const employeeId = !requested || requested === 'me' ? auth.employeeId : requested
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    return sendSuccess(res, await service.listPayslips(auth, employeeId))
  }),
)

const monthValue = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM')
const employeeIdQuery = z.union([z.literal('me'), z.string().uuid()])

/** The months an employee has an approved payslip for, so a range can be chosen from real ones. */
payslipRouter.get(
  '/months',
  canView,
  validate({ query: z.object({ employeeId: employeeIdQuery }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const requested = (req.query as { employeeId: string }).employeeId
    const employeeId = requested === 'me' ? auth.employeeId : requested
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    return sendSuccess(res, await service.listPayslipMonths(auth, employeeId))
  }),
)

/** One PDF of an employee's payslips over a month range, a page per month. */
payslipRouter.get(
  '/range',
  canView,
  validate({ query: z.object({ employeeId: employeeIdQuery, from: monthValue, to: monthValue }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as { employeeId: string; from: string; to: string }
    const employeeId = query.employeeId === 'me' ? auth.employeeId : query.employeeId
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    const file = await service.renderPayslipRange(auth, employeeId, { from: query.from, to: query.to }, auditContextFrom(req))

    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  }),
)

/** One PDF of several employees' payslips for the same run, an admin/supervisor-only action. */
payslipRouter.post(
  '/bulk-download',
  requirePermissions(PERMISSIONS.PAYSLIP_VIEW_ALL),
  validate({ body: z.object({ payrollRunId: z.string().uuid(), employeeIds: z.array(z.string().uuid()).max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const file = await service.renderPayslipsForRun(auth, req.body as service.BulkDownloadInput, auditContextFrom(req))

    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  }),
)

/** Sends the payslip PDF to each employee's WhatsApp - an admin/supervisor action. */
payslipRouter.post(
  '/send-whatsapp',
  requirePermissions(PERMISSIONS.PAYSLIP_VIEW_ALL),
  validate({ body: z.object({ payrollRunId: z.string().uuid(), employeeIds: z.array(z.string().uuid()).max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const summary = await service.sendPayslipsViaWhatsApp(auth, req.body as service.SendWhatsAppInput, auditContextFrom(req))
    return sendSuccess(
      res,
      summary,
      `Sent ${summary.sent} payslip${summary.sent === 1 ? '' : 's'}${summary.skipped + summary.failed > 0 ? ` (${summary.skipped} skipped, ${summary.failed} failed)` : ''}`,
    )
  }),
)

/** Payslips are streamed, never linked to directly (plan section 39). */
payslipRouter.get(
  '/:id/file',
  canView,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const file = await service.readPayslipFile(auth, req.params.id as string, auditContextFrom(req))

    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  }),
)
