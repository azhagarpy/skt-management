import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendSuccess } from '../../utils/http.js'
import * as service from './notifications.service.js'

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .optional(),
})

export const notificationRouter = Router()
notificationRouter.use(authenticate)

// Notifications are always personal, so there is no cross-user scope to resolve.
notificationRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const filters = req.query as unknown as z.infer<typeof listQuerySchema>
    const result = await service.listNotifications(auth.userId, filters)
    return sendSuccess(res, result.items, undefined, 200, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    })
  }),
)

notificationRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, { unread: await service.countUnread(auth.userId) })
  }),
)

notificationRouter.post(
  '/:id/read',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await service.markRead(auth.userId, req.params.id as string)
    return sendSuccess(res, null, 'Notification marked as read')
  }),
)

notificationRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const updated = await service.markAllRead(auth.userId)
    return sendSuccess(res, { updated }, 'All notifications marked as read')
  }),
)
