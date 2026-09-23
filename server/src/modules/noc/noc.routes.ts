import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './noc.service.js'

export const nocRouter = Router()
nocRouter.use(authenticate)

/** A No Objection Certificate as a PDF, streamed and never linked to directly. */
nocRouter.get(
  '/',
  requirePermissions(PERMISSIONS.PAYSLIP_VIEW_ALL),
  validate({
    query: z.object({
      employeeId: z.string().uuid(),
      purpose: z.string().max(400).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const { employeeId, purpose } = req.query as { employeeId: string; purpose?: string }
    const file = await service.generateNoc(auth, employeeId, purpose, auditContextFrom(req))

    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', String(file.buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  }),
)
