import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './leave.service.js'
import {
  balanceAdjustmentSchema,
  balanceQuerySchema,
  cancelSchema,
  createLeaveRequestSchema,
  decisionSchema,
  leavePolicySchema,
  leaveRequestListQuerySchema,
  leaveTypeSchema,
  rejectSchema,
  updateLeaveTypeSchema,
  type BalanceAdjustmentInput,
  type BalanceQuery,
  type CancelInput,
  type CreateLeaveRequestInput,
  type DecisionInput,
  type LeavePolicyInput,
  type LeaveRequestListQuery,
  type LeaveTypeInput,
  type RejectInput,
  type UpdateLeaveTypeInput,
} from './leave.validation.js'

const idParam = z.object({ id: z.string().uuid() })

export const leaveRouter = Router()
leaveRouter.use(authenticate)

const canView = requireAnyPermission(
  PERMISSIONS.LEAVE_VIEW_ALL,
  PERMISSIONS.LEAVE_VIEW_TEAM,
  PERMISSIONS.LEAVE_VIEW_SELF,
)
const canApprove = requireAnyPermission(PERMISSIONS.LEAVE_APPROVE_ALL, PERMISSIONS.LEAVE_APPROVE_TEAM)

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

leaveRouter.get(
  '/types',
  canView,
  validate({ query: z.object({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const activeOnly = (req.query as { activeOnly?: string }).activeOnly !== 'false'
    return sendSuccess(res, await service.listLeaveTypes(auth, activeOnly))
  }),
)

leaveRouter.post(
  '/types',
  requirePermissions(PERMISSIONS.LEAVE_TYPE_MANAGE),
  validate({ body: leaveTypeSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createLeaveType(auth, req.body as LeaveTypeInput, auditContextFrom(req))
    return sendCreated(res, data, 'Leave type created successfully')
  }),
)

leaveRouter.patch(
  '/types/:id',
  requirePermissions(PERMISSIONS.LEAVE_TYPE_MANAGE),
  validate({ params: idParam, body: updateLeaveTypeSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateLeaveType(
      auth,
      req.params.id as string,
      req.body as UpdateLeaveTypeInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Leave type updated successfully')
  }),
)

// ---------------------------------------------------------------------------
// Leave policies
// ---------------------------------------------------------------------------

leaveRouter.get(
  '/policies',
  requirePermissions(PERMISSIONS.LEAVE_POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listLeavePolicies(auth))
  }),
)

leaveRouter.post(
  '/policies',
  requirePermissions(PERMISSIONS.LEAVE_POLICY_MANAGE),
  validate({ body: leavePolicySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createLeavePolicy(auth, req.body as LeavePolicyInput, auditContextFrom(req))
    return sendCreated(res, data, 'Leave policy created successfully')
  }),
)

leaveRouter.put(
  '/policies/:id',
  requirePermissions(PERMISSIONS.LEAVE_POLICY_MANAGE),
  validate({ params: idParam, body: leavePolicySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateLeavePolicy(
      auth,
      req.params.id as string,
      req.body as LeavePolicyInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Leave policy updated successfully')
  }),
)

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

leaveRouter.get(
  '/balances',
  canView,
  validate({ query: balanceQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as BalanceQuery
    const employeeId = !query.employeeId || query.employeeId === 'me' ? auth.employeeId : query.employeeId
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    const year = query.year ?? new Date().getUTCFullYear()
    return sendSuccess(res, await service.getBalances(auth, employeeId, year))
  }),
)

leaveRouter.post(
  '/balances/adjust',
  requirePermissions(PERMISSIONS.LEAVE_BALANCE_MANAGE),
  validate({ body: balanceAdjustmentSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.adjustBalance(auth, req.body as BalanceAdjustmentInput, auditContextFrom(req))
    return sendSuccess(res, data, 'Leave balance adjusted successfully')
  }),
)

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

leaveRouter.get(
  '/requests',
  canView,
  validate({ query: leaveRequestListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const result = await service.listLeaveRequests(auth, req.query as unknown as LeaveRequestListQuery)
    return sendSuccess(res, result.items, undefined, 200, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

leaveRouter.post(
  '/requests',
  requireAnyPermission(PERMISSIONS.LEAVE_APPLY_SELF, PERMISSIONS.LEAVE_APPROVE_ALL, PERMISSIONS.LEAVE_APPROVE_TEAM),
  validate({ body: createLeaveRequestSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createLeaveRequest(auth, req.body as CreateLeaveRequestInput, auditContextFrom(req))
    return sendCreated(res, data, 'Leave request submitted successfully')
  }),
)

leaveRouter.get(
  '/requests/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getLeaveRequest(auth, req.params.id as string))
  }),
)

leaveRouter.post(
  '/requests/:id/approve',
  canApprove,
  validate({ params: idParam, body: decisionSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.approveLeaveRequest(
      auth,
      req.params.id as string,
      req.body as DecisionInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Leave request approved')
  }),
)

leaveRouter.post(
  '/requests/:id/reject',
  canApprove,
  validate({ params: idParam, body: rejectSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.rejectLeaveRequest(
      auth,
      req.params.id as string,
      req.body as RejectInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Leave request rejected')
  }),
)

leaveRouter.post(
  '/requests/:id/cancel',
  canView,
  validate({ params: idParam, body: cancelSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.cancelLeaveRequest(
      auth,
      req.params.id as string,
      req.body as CancelInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Leave request cancelled')
  }),
)
