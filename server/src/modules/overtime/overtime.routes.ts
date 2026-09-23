import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './overtime.service.js'
import {
  overtimeListQuerySchema,
  overtimeWeekQuerySchema,
  recordOvertimeSchema,
  updateOvertimeSchema,
  type OvertimeListQuery,
  type OvertimeWeekQuery,
  type RecordOvertimeInput,
  type UpdateOvertimeInput,
} from './overtime.validation.js'

export const overtimeRouter = Router()
overtimeRouter.use(authenticate)

const canView = requireAnyPermission(
  PERMISSIONS.OVERTIME_VIEW_ALL,
  PERMISSIONS.OVERTIME_VIEW_TEAM,
  PERMISSIONS.OVERTIME_VIEW_SELF,
)
const canManage = requireAnyPermission(PERMISSIONS.OVERTIME_MANAGE_ALL, PERMISSIONS.OVERTIME_MANAGE_TEAM)

overtimeRouter.get(
  '/',
  canView,
  validate({ query: overtimeListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listOvertime(auth, req.query as unknown as OvertimeListQuery))
  }),
)

/** The running weekly total, so the entry screen can show "X/16 hrs -> Y extra off(s)" as it is typed. */
overtimeRouter.get(
  '/week-summary',
  canView,
  validate({ query: overtimeWeekQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as OvertimeWeekQuery
    return sendSuccess(res, await service.getWeekSummary(auth, query.employeeId, query.date))
  }),
)

overtimeRouter.post(
  '/',
  canManage,
  validate({ body: recordOvertimeSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.recordOvertime(auth, req.body as RecordOvertimeInput, auditContextFrom(req))
    return sendCreated(res, data, 'Overtime recorded successfully')
  }),
)

overtimeRouter.patch(
  '/:id',
  canManage,
  validate({ params: z.object({ id: z.string().uuid() }), body: updateOvertimeSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateOvertime(auth, req.params.id as string, req.body as UpdateOvertimeInput, auditContextFrom(req))
    return sendSuccess(res, data, 'Overtime updated successfully')
  }),
)

overtimeRouter.delete(
  '/:id',
  canManage,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.deleteOvertime(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, data, 'Overtime removed successfully')
  }),
)
