import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as controller from './calendar.controller.js'
import {
  assignWeeklyOffSchema,
  grantOneOffWeeklyOffSchema,
  holidayCalendarSchema,
  holidayListQuerySchema,
  holidaySchema,
  shiftSchema,
  unassignWeeklyOffSchema,
  updateHolidaySchema,
  updateShiftSchema,
  weeklyOffCalendarQuerySchema,
  weeklyOffRuleSchema,
  workingDaysQuerySchema,
} from './calendar.validation.js'

const idParam = z.object({ id: z.string().uuid() })

export const holidayRouter = Router()
holidayRouter.use(authenticate)

holidayRouter.get(
  '/',
  requirePermissions(PERMISSIONS.HOLIDAY_VIEW),
  validate({ query: holidayListQuerySchema }),
  controller.listHolidays,
)
holidayRouter.post(
  '/',
  requirePermissions(PERMISSIONS.HOLIDAY_MANAGE),
  validate({ body: holidaySchema }),
  controller.createHoliday,
)
holidayRouter.get('/calendars', requirePermissions(PERMISSIONS.HOLIDAY_VIEW), controller.listHolidayCalendars)
holidayRouter.post(
  '/calendars',
  requirePermissions(PERMISSIONS.HOLIDAY_MANAGE),
  validate({ body: holidayCalendarSchema }),
  controller.createHolidayCalendar,
)
holidayRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.HOLIDAY_MANAGE),
  validate({ params: idParam, body: updateHolidaySchema }),
  controller.updateHoliday,
)
holidayRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.HOLIDAY_MANAGE),
  validate({ params: idParam }),
  controller.deleteHoliday,
)

export const weeklyOffRouter = Router()
weeklyOffRouter.use(authenticate)

weeklyOffRouter.get('/', requirePermissions(PERMISSIONS.WEEKLY_OFF_VIEW), controller.listWeeklyOffRules)
weeklyOffRouter.post(
  '/',
  requirePermissions(PERMISSIONS.WEEKLY_OFF_MANAGE),
  validate({ body: weeklyOffRuleSchema }),
  controller.createWeeklyOffRule,
)
weeklyOffRouter.put(
  '/:id',
  requirePermissions(PERMISSIONS.WEEKLY_OFF_MANAGE),
  validate({ params: idParam, body: weeklyOffRuleSchema }),
  controller.updateWeeklyOffRule,
)
weeklyOffRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.WEEKLY_OFF_MANAGE),
  validate({ params: idParam }),
  controller.deleteWeeklyOffRule,
)

/**
 * Per-employee weekly off assignments (the calendar UI): admins assign any
 * employee, supervisors only their own team.
 */
const canAssignWeeklyOff = requireAnyPermission(PERMISSIONS.WEEKLY_OFF_MANAGE, PERMISSIONS.WEEKLY_OFF_ASSIGN_TEAM)

weeklyOffRouter.get(
  '/assignments/calendar',
  canAssignWeeklyOff,
  validate({ query: weeklyOffCalendarQuerySchema }),
  controller.getWeeklyOffCalendar,
)
weeklyOffRouter.post(
  '/assignments',
  canAssignWeeklyOff,
  validate({ body: assignWeeklyOffSchema }),
  controller.assignWeeklyOff,
)
weeklyOffRouter.post(
  '/assignments/one-off',
  canAssignWeeklyOff,
  validate({ body: grantOneOffWeeklyOffSchema }),
  controller.grantOneOffWeeklyOff,
)
weeklyOffRouter.post(
  '/assignments/unassign',
  canAssignWeeklyOff,
  validate({ body: unassignWeeklyOffSchema }),
  controller.unassignWeeklyOff,
)
weeklyOffRouter.delete(
  '/assignments/:id',
  canAssignWeeklyOff,
  validate({ params: idParam }),
  controller.deleteWeeklyOffAssignment,
)
weeklyOffRouter.delete(
  '/assignments/one-off/:id',
  canAssignWeeklyOff,
  validate({ params: idParam }),
  controller.deleteExtraWeeklyOff,
)

export const calendarRouter = Router()
calendarRouter.use(authenticate)

/** Shared read-only view of the configured calendar for a date range. */
calendarRouter.get(
  '/working-days',
  requirePermissions(PERMISSIONS.HOLIDAY_VIEW),
  validate({ query: workingDaysQuerySchema }),
  controller.getWorkingDays,
)

export const shiftRouter = Router()
shiftRouter.use(authenticate)

shiftRouter.get('/', requirePermissions(PERMISSIONS.WEEKLY_OFF_VIEW), controller.listShifts)
shiftRouter.post(
  '/',
  requirePermissions(PERMISSIONS.SHIFT_MANAGE),
  validate({ body: shiftSchema }),
  controller.createShift,
)
shiftRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.SHIFT_MANAGE),
  validate({ params: idParam, body: updateShiftSchema }),
  controller.updateShift,
)
shiftRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.SHIFT_MANAGE),
  validate({ params: idParam }),
  controller.deleteShift,
)
