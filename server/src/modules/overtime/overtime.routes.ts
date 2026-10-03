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
import * as paidOffs from './paid-offs.js'
import {
  overtimeEmployeeQuerySchema,
  overtimeListQuerySchema,
  overtimeWeekQuerySchema,
  paidOffCalendarQuerySchema,
  paidOffListQuerySchema,
  recordOvertimeSchema,
  schedulePaidOffSchema,
  updateOvertimeSchema,
  type OvertimeEmployeeQuery,
  type OvertimeListQuery,
  type OvertimeWeekQuery,
  type PaidOffCalendarQuery,
  type PaidOffListQuery,
  type RecordOvertimeInput,
  type SchedulePaidOffInput,
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

/** Whether the employee's OT is paid, and the rate a new entry for them starts at. */
overtimeRouter.get(
  '/employee-settings',
  canView,
  validate({ query: overtimeEmployeeQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as OvertimeEmployeeQuery
    return sendSuccess(res, await service.getEmployeeOvertimeSettings(auth, query.employeeId, query.date))
  }),
)

/** The running weekly total, so the entry screen can show the hours and the paid offs they earn as it is typed. */
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

/** Supply employees' paid offs: earned, scheduled and still to schedule (paid-offs.ts). */
overtimeRouter.get(
  '/paid-offs',
  canView,
  validate({ query: paidOffListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await paidOffs.listPaidOffs(auth, req.query as unknown as PaidOffListQuery))
  }),
)

/** One employee's days - holidays, weekly offs, leave, attendance - and which can take a paid off. */
overtimeRouter.get(
  '/paid-offs/calendar',
  canView,
  validate({ query: paidOffCalendarQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await paidOffs.paidOffCalendar(auth, req.query as unknown as PaidOffCalendarQuery))
  }),
)

/** Gives one of an employee's earned paid offs the date chosen for it. */
overtimeRouter.post(
  '/paid-offs',
  canManage,
  validate({ body: schedulePaidOffSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const { result, message } = await paidOffs.schedulePaidOff(auth, req.body as SchedulePaidOffInput, auditContextFrom(req))
    return sendCreated(res, result, message)
  }),
)

overtimeRouter.delete(
  '/paid-offs/:id',
  canManage,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const message = await paidOffs.removePaidOff(auth, req.params.id as string, auditContextFrom(req))
    return sendSuccess(res, null, message)
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
