import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './appointment.service.js'

export const appointmentRouter = Router()
appointmentRouter.use(authenticate)

/**
 * The statutory Letter of Appointment as a PDF, streamed and never linked to
 * directly. It quotes the employee's wage, so it is gated the same way a
 * payslip is rather than on the ordinary employee-view permission.
 */
appointmentRouter.get(
  '/',
  requirePermissions(PERMISSIONS.PAYSLIP_VIEW_ALL),
  validate({
    query: z.object({
      employeeId: z.string().uuid(),
      otherInformation: z.string().max(600).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const { employeeId, otherInformation } = req.query as { employeeId: string; otherInformation?: string }
    const file = await service.generateAppointmentLetter(auth, employeeId, otherInformation, auditContextFrom(req))

    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  }),
)
