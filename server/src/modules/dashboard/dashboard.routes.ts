import { Router } from 'express'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import * as service from './dashboard.service.js'

export const dashboardRouter = Router()
dashboardRouter.use(authenticate)

/**
 * One endpoint, three shapes. The server decides which dashboard the caller is
 * entitled to rather than trusting a client-supplied role.
 */
dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.dashboardForRole(auth))
  }),
)
