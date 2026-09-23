import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendSuccess } from '../../utils/http.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { uuidParam } from '../organization/organization.validation.js'
import * as service from './messaging.service.js'
import { whatsappStatus } from './whatsapp.service.js'

/** Message scenarios, broadcasts and the delivery log. */

const templateNameSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[a-z0-9_]+$/, 'A WhatsApp template name may contain lower-case letters, digits and underscores only')

const scenarioUpdateSchema = z.object({
  whatsappEnabled: z.boolean().optional(),
  templateName: templateNameSchema.nullish(),
  templateLanguage: z.string().trim().min(2).max(10).optional(),
  templateVariables: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
})

const broadcastSchema = z.object({
  title: z.string().trim().min(2, 'A title is required').max(120),
  body: z.string().trim().min(2, 'A message is required').max(1000),
  userIds: z.array(z.string().uuid()).min(1, 'Choose at least one recipient').max(500),
  sendInApp: z.boolean().default(true),
  sendWhatsapp: z.boolean().default(false),
  templateName: templateNameSchema.nullish(),
  templateLanguage: z.string().trim().min(2).max(10).default('en'),
  templateVariables: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
})

const outboxQuerySchema = z.object({
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']).optional(),
  eventKey: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export const messagingRouter = Router()
messagingRouter.use(authenticate)

/** Whether messages will actually be delivered, and why not when they will not. */
messagingRouter.get(
  '/status',
  requirePermissions(PERMISSIONS.MESSAGE_VIEW),
  asyncHandler(async (_req, res) => sendSuccess(res, whatsappStatus())),
)

messagingRouter.get(
  '/scenarios',
  requirePermissions(PERMISSIONS.MESSAGE_VIEW),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listScenarios(auth.organizationId))
  }),
)

/** Suggested wording for every message, ready to register with WhatsApp. */
messagingRouter.get(
  '/templates',
  requirePermissions(PERMISSIONS.MESSAGE_VIEW),
  asyncHandler(async (_req, res) => sendSuccess(res, service.listTemplates())),
)

messagingRouter.post(
  '/scenarios/apply-templates',
  requirePermissions(PERMISSIONS.MESSAGE_MANAGE),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const updated = await service.applySuggestedTemplates(auth.organizationId, auditContextFrom(req))
    return sendSuccess(
      res,
      { updated },
      updated === 0 ? 'Every event already has a template name' : `Suggested templates named on ${updated} events`,
    )
  }),
)

messagingRouter.patch(
  '/scenarios/:id',
  requirePermissions(PERMISSIONS.MESSAGE_MANAGE),
  validate({ params: uuidParam('id'), body: scenarioUpdateSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateScenario(
      auth.organizationId,
      req.params.id as string,
      req.body as service.ScenarioUpdate,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Scenario updated')
  }),
)

messagingRouter.get(
  '/outbox',
  requirePermissions(PERMISSIONS.MESSAGE_VIEW),
  validate({ query: outboxQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const query = req.query as unknown as z.infer<typeof outboxQuerySchema>
    const page = await service.listOutbox(auth.organizationId, query)
    return sendSuccess(res, page.items, undefined, 200, {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
    })
  }),
)

messagingRouter.get(
  '/broadcasts',
  requirePermissions(PERMISSIONS.MESSAGE_VIEW),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.listBroadcasts(auth.organizationId))
  }),
)

messagingRouter.post(
  '/broadcasts',
  requirePermissions(PERMISSIONS.MESSAGE_BROADCAST),
  validate({ body: broadcastSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.sendBroadcast(
      auth.organizationId,
      req.body as service.BroadcastInput,
      auditContextFrom(req),
    )
    return sendCreated(res, data, `Sent to ${data.sentCount} of ${data.recipientCount} recipients`)
  }),
)
