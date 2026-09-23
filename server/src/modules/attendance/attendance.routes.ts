import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadAttendanceSheet } from '../../middleware/upload.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { isoDateSchema } from '../employees/employees.validation.js'
import * as service from './attendance.service.js'
import * as importService from './attendance-import.service.js'
import { attendanceImportBodySchema, type AttendanceImportBody } from './attendance-import.validation.js'
import {
  attendanceListQuerySchema,
  bulkMarkAttendanceSchema,
  dailySheetQuerySchema,
  markAttendanceSchema,
  monthlyQuerySchema,
  updateAttendanceSchema,
  type AttendanceListQuery,
  type BulkMarkAttendanceInput,
  type DailySheetQuery,
  type MarkAttendanceInput,
  type MonthlyQuery,
  type UpdateAttendanceInput,
} from './attendance.validation.js'

export const attendanceRouter = Router()
attendanceRouter.use(authenticate)

const canView = requireAnyPermission(
  PERMISSIONS.ATTENDANCE_VIEW_ALL,
  PERMISSIONS.ATTENDANCE_VIEW_TEAM,
  PERMISSIONS.ATTENDANCE_VIEW_SELF,
)
const canManage = requireAnyPermission(PERMISSIONS.ATTENDANCE_MANAGE_ALL, PERMISSIONS.ATTENDANCE_MANAGE_TEAM)

attendanceRouter.get(
  '/',
  canView,
  validate({ query: attendanceListQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listAttendance(auth, req.query as unknown as AttendanceListQuery))
  }),
)

/** The daily marking grid (plan section 6). */
attendanceRouter.get(
  '/daily',
  canView,
  validate({ query: dailySheetQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getDailySheet(auth, req.query as unknown as DailySheetQuery))
  }),
)

/** The monthly calendar view (plan section 7). */
attendanceRouter.get(
  '/monthly',
  canView,
  validate({ query: monthlyQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getMonthlyCalendar(auth, req.query as unknown as MonthlyQuery))
  }),
)

attendanceRouter.get(
  '/summary',
  canView,
  validate({ query: z.object({ from: isoDateSchema, to: isoDateSchema }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const { from, to } = req.query as unknown as { from: string; to: string }
    return sendSuccess(res, await service.getSummary(auth, from, to))
  }),
)

attendanceRouter.post(
  '/',
  canManage,
  validate({ body: markAttendanceSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.markAttendance(auth, req.body as MarkAttendanceInput, auditContextFrom(req))
    return sendCreated(res, data, 'Attendance saved successfully')
  }),
)

/**
 * Face ID sheet import. multer runs before validation so the multipart fields are
 * populated. `/import/preview` is a dry run; `/import` writes.
 */
attendanceRouter.post(
  '/import/preview',
  canManage,
  uploadAttendanceSheet,
  validate({ body: attendanceImportBodySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await importService.previewImport(auth, req.file, req.body as AttendanceImportBody))
  }),
)

attendanceRouter.post(
  '/import',
  canManage,
  uploadAttendanceSheet,
  validate({ body: attendanceImportBodySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await importService.commitImport(auth, req.file, req.body as AttendanceImportBody, auditContextFrom(req))
    const parts = [`${data.created} added`]
    if (data.overridden > 0) parts.push(`${data.overridden} overridden`)
    return sendSuccess(res, data, `Attendance imported: ${parts.join(', ')}`)
  }),
)

attendanceRouter.post(
  '/bulk',
  canManage,
  validate({ body: bulkMarkAttendanceSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.bulkMarkAttendance(auth, req.body as BulkMarkAttendanceInput, auditContextFrom(req))
    const message =
      data.skipped.length > 0
        ? `Saved attendance for ${data.saved} employee(s); ${data.skipped.length} skipped`
        : `Saved attendance for ${data.saved} employee(s)`
    return sendSuccess(res, data, message)
  }),
)

/**
 * Fills in holidays and weekly offs for unmarked days from the configured
 * calendar, so a month is complete before payroll is calculated.
 */
attendanceRouter.post(
  '/apply-calendar',
  canManage,
  validate({ body: z.object({ from: isoDateSchema, to: isoDateSchema }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const { from, to } = req.body as { from: string; to: string }
    const data = await service.applyCalendarDefaults(auth, from, to, auditContextFrom(req))
    const message =
      data.cleared > 0
        ? `Calendar applied: ${data.created} day(s) marked, ${data.cleared} no longer a holiday or weekly off cleared`
        : `Applied calendar defaults to ${data.created} day(s)`
    return sendSuccess(res, data, message)
  }),
)

attendanceRouter.get(
  '/:id/history',
  canView,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getAttendanceHistory(auth, req.params.id as string))
  }),
)

attendanceRouter.patch(
  '/:id',
  canManage,
  validate({ params: z.object({ id: z.string().uuid() }), body: updateAttendanceSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateAttendance(
      auth,
      req.params.id as string,
      req.body as UpdateAttendanceInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Attendance updated successfully')
  }),
)
