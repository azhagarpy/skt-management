import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadPaymentProof, uploadSingleDocument } from '../../middleware/upload.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as paymentsService from '../payments/payments.service.js'
import * as payslipService from '../payslips/payslips.service.js'
import * as service from './payroll.service.js'
import {
  adjustmentCreateSchema,
  adjustmentListQuerySchema,
  createRunSchema,
  updateRunPeriodSchema,
  itemListQuerySchema,
  myPayrollQuerySchema,
  runListQuerySchema,
  type AdjustmentCreateInput,
  type AdjustmentListQuery,
  type CreateRunInput,
  type UpdateRunPeriodInput,
  type ItemListQuery,
  type MyPayrollQuery,
  type RunListQuery,
} from './payroll.validation.js'

const idParam = z.object({ id: z.string().uuid() })
const itemIdParam = z.object({ payrollItemId: z.string().uuid() })

export const payrollRouter = Router()
payrollRouter.use(authenticate)

const canView = requireAnyPermission(
  PERMISSIONS.PAYROLL_VIEW_ALL,
  PERMISSIONS.PAYROLL_VIEW_TEAM,
  PERMISSIONS.PAYROLL_VIEW_SELF,
)

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

payrollRouter.get(
  '/runs',
  requireAnyPermission(PERMISSIONS.PAYROLL_VIEW_ALL, PERMISSIONS.PAYROLL_VIEW_TEAM),
  validate({ query: runListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const result = await service.listRuns(auth, req.query as unknown as RunListQuery)
    return sendSuccess(res, result.items, undefined, 200, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

payrollRouter.post(
  '/runs',
  requirePermissions(PERMISSIONS.PAYROLL_PROCESS),
  validate({ body: createRunSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createRun(auth, req.body as CreateRunInput, auditContextFrom(req))
    return sendCreated(res, data, 'Payroll run created successfully')
  }),
)

payrollRouter.get(
  '/runs/:id',
  requireAnyPermission(PERMISSIONS.PAYROLL_VIEW_ALL, PERMISSIONS.PAYROLL_VIEW_TEAM),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getRun(auth, req.params.id as string))
  }),
)

/** Changes the dates a run covers; a calculated run goes back to draft to be recalculated. */
payrollRouter.patch(
  '/runs/:id/period',
  requirePermissions(PERMISSIONS.PAYROLL_PROCESS),
  validate({ params: idParam, body: updateRunPeriodSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateRunPeriod(
      auth,
      req.params.id as string,
      req.body as UpdateRunPeriodInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Payroll period updated')
  }),
)

/**
 * Recalculates the whole run. This is the long-running operation of the module;
 * it is idempotent, so retrying after a failure is safe.
 */
payrollRouter.post(
  '/runs/:id/calculate',
  requirePermissions(PERMISSIONS.PAYROLL_PROCESS),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.calculateRun(auth, req.params.id as string, auditContextFrom(req))
    const message =
      data.skipped.length > 0
        ? `Calculated ${data.employeesProcessed} employee(s); ${data.skipped.length} skipped`
        : `Calculated payroll for ${data.employeesProcessed} employee(s)`
    return sendSuccess(res, data, message)
  }),
)

/** Removes a run that was created but never calculated. */
payrollRouter.delete(
  '/runs/:id',
  requirePermissions(PERMISSIONS.PAYROLL_DELETE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await service.deleteRun(auth, req.params.id as string, auditContextFrom(req))
    return sendNoContent(res, 'Payroll run deleted')
  }),
)

payrollRouter.post(
  '/runs/:id/submit-review',
  requirePermissions(PERMISSIONS.PAYROLL_PROCESS),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.submitForReview(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, 'Payroll submitted for review')
  }),
)

payrollRouter.post(
  '/runs/:id/approve',
  requirePermissions(PERMISSIONS.PAYROLL_APPROVE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.approveRun(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, 'Payroll approved')
  }),
)

payrollRouter.post(
  '/runs/:id/lock',
  requirePermissions(PERMISSIONS.PAYROLL_LOCK),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.lockRun(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, 'Payroll locked')
  }),
)

payrollRouter.get(
  '/runs/:id/items',
  canView,
  validate({ params: idParam, query: itemListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const result = await service.listItems(auth, req.params.id as string, req.query as unknown as ItemListQuery)
    return sendSuccess(res, result.items, undefined, 200, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

payrollRouter.get(
  '/runs/:id/payment-summary',
  requirePermissions(PERMISSIONS.PAYMENT_VIEW_ALL),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await paymentsService.getRunPaymentSummary(auth, req.params.id as string))
  }),
)

payrollRouter.post(
  '/runs/:id/payslips',
  requirePermissions(PERMISSIONS.PAYSLIP_GENERATE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await payslipService.generateForRun(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, `Generated ${data.generated} payslip(s)`)
  }),
)

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** The signed-in employee's own payroll history. */
payrollRouter.get(
  '/my-payroll',
  canView,
  validate({ query: myPayrollQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as MyPayrollQuery
    const employeeId = !query.employeeId || query.employeeId === 'me' ? auth.employeeId : query.employeeId
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    return sendSuccess(res, await service.listMyPayroll(auth, employeeId, query.year, query.limit))
  }),
)

payrollRouter.get(
  '/items/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getItem(auth, req.params.id as string))
  }),
)

// ---------------------------------------------------------------------------
// Payments (plan section 48: /payroll/:payrollItemId/payments)
// ---------------------------------------------------------------------------

payrollRouter.get(
  '/:payrollItemId/payments',
  requireAnyPermission(PERMISSIONS.PAYMENT_VIEW_ALL, PERMISSIONS.PAYMENT_VIEW_SELF),
  validate({ params: itemIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await paymentsService.listPayments(auth, req.params.payrollItemId as string))
  }),
)

payrollRouter.post(
  '/:payrollItemId/payments',
  requirePermissions(PERMISSIONS.PAYMENT_MANAGE),
  validate({ params: itemIdParam, body: paymentsService.paymentCreateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await paymentsService.recordPayment(
      auth,
      req.params.payrollItemId as string,
      req.body as paymentsService.PaymentCreateInput,
      auditContextFrom(req),
    )
    return sendCreated(res, data, 'Payment recorded successfully')
  }),
)

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

payrollRouter.get(
  '/adjustments',
  requireAnyPermission(PERMISSIONS.PAYROLL_ADJUST, PERMISSIONS.PAYROLL_VIEW_ALL),
  validate({ query: adjustmentListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listAdjustments(auth, req.query as unknown as AdjustmentListQuery))
  }),
)

payrollRouter.post(
  '/adjustments',
  requirePermissions(PERMISSIONS.PAYROLL_ADJUST),
  validate({ body: adjustmentCreateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createAdjustment(auth, req.body as AdjustmentCreateInput, auditContextFrom(req))
    return sendCreated(res, data, 'Payroll adjustment created successfully')
  }),
)

payrollRouter.delete(
  '/adjustments/:id',
  requirePermissions(PERMISSIONS.PAYROLL_ADJUST),
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await service.deleteAdjustment(auth, req.params.id as string, auditContextFrom(req))
    return sendNoContent(res, 'Payroll adjustment removed successfully')
  }),
)

// ---------------------------------------------------------------------------
// Standalone payments router
// ---------------------------------------------------------------------------

export const paymentRouter = Router()
paymentRouter.use(authenticate)

paymentRouter.post(
  '/bulk',
  requirePermissions(PERMISSIONS.PAYMENT_MANAGE),
  // multer runs first so a multipart body (the form with a reference document) is parsed;
  // a plain JSON request passes straight through it.
  uploadPaymentProof,
  validate({ body: paymentsService.bulkPaymentSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await paymentsService.recordBulkPayment(
      auth,
      req.body as paymentsService.BulkPaymentInput,
      auditContextFrom(req),
      req.file,
    )
    return sendSuccess(res, data, `Recorded payment for ${data.itemsPaid} employee(s)`)
  }),
)

// Proof of payment: upload, fetch, remove.
paymentRouter.post(
  '/:id/proof',
  requirePermissions(PERMISSIONS.PAYMENT_MANAGE),
  uploadSingleDocument,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    if (!req.file) throw ApiError.badRequest('Attach a PDF, PNG or JPEG file under the "file" field')
    const data = await paymentsService.attachPaymentProof(
      auth,
      req.params.id as string,
      req.file,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Proof attached')
  }),
)

paymentRouter.get(
  '/:id/proof',
  requirePermissions(PERMISSIONS.PAYMENT_VIEW_ALL),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const file = await paymentsService.readPaymentProof(auth, req.params.id as string)
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.send(file.buffer)
  }),
)

paymentRouter.delete(
  '/:id/proof',
  requirePermissions(PERMISSIONS.PAYMENT_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await paymentsService.removePaymentProof(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, 'Proof removed')
  }),
)

paymentRouter.post(
  '/:id/reverse',
  requirePermissions(PERMISSIONS.PAYMENT_MANAGE),
  validate({ params: idParam, body: paymentsService.paymentReverseSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await paymentsService.reversePayment(
      auth,
      req.params.id as string,
      req.body as paymentsService.PaymentReverseInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Payment reversed successfully')
  }),
)
