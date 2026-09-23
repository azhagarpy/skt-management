import { pool, queryOne, queryRows, type Queryable } from '../../database/pool.js'
import { logger } from '../../utils/logger.js'
import { ApiError } from '../../utils/api-error.js'
import { buildPaginated, offsetOf, type Paginated } from '../../utils/pagination.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { normalisePhone, whatsapp, whatsappIsLive, WhatsAppSendError } from './whatsapp.service.js'

/**
 * Messaging.
 *
 * Two ways a WhatsApp message leaves the system:
 *
 *  - a *scenario* fires automatically when something happens (leave approved,
 *    payslip ready). Scenarios are configured per event and are off until an
 *    administrator turns one on and names an approved template.
 *  - a *broadcast* is sent deliberately to a chosen set of people.
 *
 * Both write to the same outbox, which is the delivery log the admin screen
 * reads. Nothing here is allowed to throw into a business operation: failing to
 * tell someone about a payroll run must never roll the payroll run back.
 */

/**
 * A ready-to-register WhatsApp template.
 *
 * WhatsApp only delivers a business-initiated message from a template the
 * provider has approved, so each event ships with suggested wording. Register
 * it in the WhatsApp Business account under the same name, then the scenario
 * can use it as it is. {{1}}, {{2}}, ... follow the event's variables in order.
 */
export const TEMPLATE_LANGUAGE = 'en'
export const TEMPLATE_CATEGORY = 'UTILITY'

interface SuggestedTemplate {
  name: string
  body: string
}

/** The events a scenario can be attached to, and what each can put in a template. */
export const SCENARIO_CATALOGUE: {
  eventKey: string
  name: string
  description: string
  variables: string[]
  template: SuggestedTemplate
}[] = [
  {
    eventKey: 'LEAVE_REQUEST_SUBMITTED',
    template: {
      name: 'skt_leave_request_submitted',
      body:
        'Hello {{1}}, a leave request is waiting for your review. {{2}} - {{3}} Please open the SKT app to approve or reject it.',
    },
    name: 'Leave request submitted',
    description: 'Sent to the approver when someone applies for leave.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'LEAVE_REQUEST_APPROVED',
    template: {
      name: 'skt_leave_approved',
      body:
        'Hello {{1}}, there is good news on your leave request. {{2}} - {{3}} Open the SKT app to see the details.',
    },
    name: 'Leave approved',
    description: 'Sent to the employee when their leave is approved.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'LEAVE_REQUEST_REJECTED',
    template: {
      name: 'skt_leave_rejected',
      body:
        'Hello {{1}}, there is an update on your leave request. {{2}} - {{3}} Please speak to your supervisor if you have any questions.',
    },
    name: 'Leave rejected',
    description: 'Sent to the employee when their leave is rejected.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'LEAVE_REQUEST_CANCELLED',
    template: {
      name: 'skt_leave_cancelled',
      body:
        'Hello {{1}}, a leave request has been cancelled. {{2}} - {{3}} Open the SKT app for the details.',
    },
    name: 'Leave cancelled',
    description: 'Sent when a leave request is cancelled.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'DOCUMENT_UPLOADED',
    template: {
      name: 'skt_document_uploaded',
      body:
        'Hello {{1}}, a document is waiting for your review. {{2}} - {{3}} Please open the SKT app to verify it.',
    },
    name: 'Document uploaded',
    description: 'Sent to reviewers when an employee uploads a document.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'DOCUMENT_VERIFIED',
    template: {
      name: 'skt_document_verified',
      body:
        'Hello {{1}}, your document has been verified. {{2}} - {{3}} No further action is needed from you.',
    },
    name: 'Document verified',
    description: 'Sent to the employee when a document is accepted.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'DOCUMENT_REJECTED',
    template: {
      name: 'skt_document_rejected',
      body:
        'Hello {{1}}, one of your documents could not be accepted. {{2}} - {{3}} Please upload a corrected copy in the SKT app.',
    },
    name: 'Document rejected',
    description: 'Sent to the employee when a document is rejected.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'PAYROLL_APPROVED',
    template: {
      name: 'skt_payroll_approved',
      body:
        'Hello {{1}}, there is a payroll update from SKT. {{2}} - {{3}} Open the SKT app for the details.',
    },
    name: 'Payroll approved',
    description: 'Sent when a payroll run is approved.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'PAYROLL_LOCKED',
    template: {
      name: 'skt_payroll_locked',
      body:
        'Hello {{1}}, there is a payroll update from SKT. {{2}} - {{3}} Open the SKT app for the details.',
    },
    name: 'Payroll locked',
    description: 'Sent when a payroll run is locked.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'PAYSLIP_AVAILABLE',
    template: {
      name: 'skt_payslip_available',
      body:
        'Hello {{1}}, your payslip is ready. {{2}} - {{3}} You can download it from the SKT app.',
    },
    name: 'Payslip available',
    description: 'Sent to the employee when their payslip can be downloaded.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'PAYMENT_RECORDED',
    template: {
      name: 'skt_salary_paid',
      body:
        'Hello {{1}}, your salary payment has been recorded. {{2}} - {{3}} You can see the details in the SKT app.',
    },
    name: 'Salary paid',
    description: 'Sent to the employee when a salary payment is recorded against them.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'PROFILE_INCOMPLETE',
    template: {
      name: 'skt_profile_incomplete',
      body:
        'Hello {{1}}, your profile needs a few more details. {{2}} - {{3}} Please update it in the SKT app.',
    },
    name: 'Profile incomplete',
    description: 'Sent to the employee when required details or documents are missing.',
    variables: ['recipientName', 'title', 'body'],
  },
  {
    eventKey: 'GENERAL',
    template: {
      name: 'skt_general_notice',
      body:
        'Hello {{1}}, you have a new notice from SKT. {{2}} - {{3}} Open the SKT app to read more.',
    },
    name: 'General notice',
    description: 'Anything raised without a more specific event.',
    variables: ['recipientName', 'title', 'body'],
  },
]

const CATALOGUE_BY_KEY = new Map(SCENARIO_CATALOGUE.map((entry) => [entry.eventKey, entry]))

/** The wording suggested for a message sent from the "Send a message" screen. */
export const BROADCAST_TEMPLATE: SuggestedTemplate = {
  name: 'skt_announcement',
  body: 'Hello {{1}}, here is a message from SKT. {{2}} - {{3}} Open the SKT app for more.',
}

const BROADCAST_VARIABLE_ORDER = ['recipientName', 'title', 'body']

function presentTemplate(template: SuggestedTemplate, variables: string[]) {
  return {
    name: template.name,
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    body: template.body,
    variables,
  }
}

/**
 * Every template the system can use, for the admin to register with WhatsApp:
 * one per event, plus the one for broadcasts (which has no event key).
 */
export function listTemplates() {
  return [
    ...SCENARIO_CATALOGUE.map((entry) => ({
      eventKey: entry.eventKey as string | null,
      forName: entry.name,
      ...presentTemplate(entry.template, entry.variables),
    })),
    {
      eventKey: null as string | null,
      forName: 'Sent message (broadcast)',
      ...presentTemplate(BROADCAST_TEMPLATE, BROADCAST_VARIABLE_ORDER),
    },
  ]
}

export interface ScenarioRow {
  id: string
  event_key: string
  name: string
  description: string | null
  whatsapp_enabled: boolean
  template_name: string | null
  template_language: string
  template_variables: string[]
  updated_at: Date
}

function presentScenario(row: ScenarioRow) {
  return {
    id: row.id,
    eventKey: row.event_key,
    name: row.name,
    description: row.description,
    whatsappEnabled: row.whatsapp_enabled,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    templateVariables: row.template_variables ?? [],
    availableVariables: CATALOGUE_BY_KEY.get(row.event_key)?.variables ?? [],
    suggestedTemplate: (() => {
      const entry = CATALOGUE_BY_KEY.get(row.event_key)
      return entry ? presentTemplate(entry.template, entry.variables) : null
    })(),
    /** A scenario is only live once it is on *and* points at a template. */
    isReady: row.whatsapp_enabled && Boolean(row.template_name),
    updatedAt: row.updated_at,
  }
}

/**
 * Creates any scenario rows this organization does not have yet.
 *
 * Called before every read so a new event added to the catalogue appears in the
 * admin screen without a migration.
 */
export async function ensureScenarios(organizationId: string, db: Queryable = pool): Promise<void> {
  for (const entry of SCENARIO_CATALOGUE) {
    await db.query(
      `INSERT INTO message_scenarios (organization_id, event_key, name, description, template_variables)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (organization_id, event_key) DO NOTHING`,
      [organizationId, entry.eventKey, entry.name, entry.description, JSON.stringify(entry.variables)],
    )
  }
}

export async function listScenarios(organizationId: string) {
  await ensureScenarios(organizationId)
  const rows = await queryRows<ScenarioRow>(
    pool,
    'SELECT * FROM message_scenarios WHERE organization_id = $1 ORDER BY name',
    [organizationId],
  )
  return rows.map(presentScenario)
}

export interface ScenarioUpdate {
  whatsappEnabled?: boolean
  templateName?: string | null
  templateLanguage?: string
  templateVariables?: string[]
}

export async function updateScenario(
  organizationId: string,
  id: string,
  input: ScenarioUpdate,
  context: AuditContext,
) {
  const existing = await queryOne<ScenarioRow>(
    pool,
    'SELECT * FROM message_scenarios WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  )
  if (!existing) throw ApiError.notFound('Message scenario')

  const nextTemplate = input.templateName === undefined ? existing.template_name : input.templateName
  if (input.whatsappEnabled && !nextTemplate) {
    throw ApiError.businessRule(
      'Name the approved WhatsApp template before turning this scenario on. WhatsApp refuses free-form business-initiated messages.',
    )
  }

  // Only variables this event actually produces can fill the template.
  const allowed = new Set(CATALOGUE_BY_KEY.get(existing.event_key)?.variables ?? [])
  const variables = input.templateVariables ?? (existing.template_variables as string[])
  const unknown = variables.filter((name) => !allowed.has(name))
  if (unknown.length > 0) {
    throw ApiError.badRequest(`This event does not provide: ${unknown.join(', ')}`)
  }

  const row = await queryOne<ScenarioRow>(
    pool,
    `UPDATE message_scenarios
        SET whatsapp_enabled = COALESCE($3, whatsapp_enabled),
            template_name = $4,
            template_language = COALESCE($5, template_language),
            template_variables = $6::jsonb,
            updated_by = $7
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [
      id,
      organizationId,
      input.whatsappEnabled ?? null,
      nextTemplate,
      input.templateLanguage ?? null,
      JSON.stringify(variables),
      context.userId,
    ],
  )

  await recordAudit({
    ...context,
    action: 'MESSAGE_SCENARIO_UPDATED',
    entityType: 'message_scenario',
    entityId: id,
    oldValues: { enabled: existing.whatsapp_enabled, template: existing.template_name },
    newValues: { enabled: row?.whatsapp_enabled, template: row?.template_name },
  })

  return row ? presentScenario(row) : null
}

/**
 * Names the suggested template on every scenario that has none yet.
 *
 * Scenarios stay switched off: naming a template is not the same as having got
 * it approved, and a scenario that fires against an unapproved template only
 * produces failed sends. Scenarios that already name a template are untouched.
 */
export async function applySuggestedTemplates(organizationId: string, context: AuditContext): Promise<number> {
  await ensureScenarios(organizationId)

  let updated = 0
  for (const entry of SCENARIO_CATALOGUE) {
    const result = await pool.query(
      `UPDATE message_scenarios
          SET template_name = $3,
              template_language = $4,
              template_variables = $5::jsonb,
              updated_by = $6
        WHERE organization_id = $1 AND event_key = $2 AND template_name IS NULL`,
      [
        organizationId,
        entry.eventKey,
        entry.template.name,
        TEMPLATE_LANGUAGE,
        JSON.stringify(entry.variables),
        context.userId,
      ],
    )
    updated += result.rowCount ?? 0
  }

  await recordAudit({
    ...context,
    action: 'MESSAGE_SCENARIO_UPDATED',
    entityType: 'message_scenario',
    entityId: null,
    newValues: { suggestedTemplatesApplied: updated },
  })

  return updated
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface OutboxDraft {
  organizationId: string
  eventKey?: string | null
  broadcastId?: string | null
  userId?: string | null
  employeeId?: string | null
  recipientPhone: string | null
  templateName: string | null
  templateLanguage: string | null
  variables: string[]
  preview: string
}

async function recordOutbox(
  draft: OutboxDraft,
  status: 'SENT' | 'FAILED' | 'SKIPPED',
  reason: string | null,
  providerMessageId: string | null,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO message_outbox
       (organization_id, event_key, broadcast_id, user_id, employee_id, recipient_phone,
        template_name, template_language, template_variables, preview, status, status_reason,
        provider_message_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
    [
      draft.organizationId,
      draft.eventKey ?? null,
      draft.broadcastId ?? null,
      draft.userId ?? null,
      draft.employeeId ?? null,
      draft.recipientPhone,
      draft.templateName,
      draft.templateLanguage,
      JSON.stringify(draft.variables),
      draft.preview,
      status,
      reason,
      providerMessageId,
      status === 'SENT' ? new Date() : null,
    ],
  )
}

/** Sends one templated message and records the attempt either way. */
async function deliver(draft: OutboxDraft): Promise<boolean> {
  if (!draft.recipientPhone) {
    await recordOutbox(draft, 'SKIPPED', 'No usable mobile number on record', null)
    return false
  }
  if (!draft.templateName) {
    await recordOutbox(draft, 'SKIPPED', 'No WhatsApp template configured', null)
    return false
  }

  try {
    const result = await whatsapp.send({
      to: draft.recipientPhone,
      templateName: draft.templateName,
      languageCode: draft.templateLanguage ?? 'en',
      variables: draft.variables,
    })
    await recordOutbox(
      draft,
      'SENT',
      whatsappIsLive() ? null : (result.detail ?? null),
      result.providerMessageId,
    )
    return true
  } catch (error) {
    const reason =
      error instanceof WhatsAppSendError ? error.message : 'The message could not be sent. See the server log.'
    logger.warn({ err: error, event: draft.eventKey }, 'WhatsApp delivery failed')
    await recordOutbox(draft, 'FAILED', reason, null)
    return false
  }
}

export interface DocumentDeliveryInput {
  organizationId: string
  employeeId: string
  recipientPhone: string | null
  templateName: string
  templateLanguage: string
  variables: string[]
  documentBuffer: Buffer
  documentMimeType: string
  filename: string
  preview: string
}

export interface DocumentDeliveryResult {
  status: 'SENT' | 'SKIPPED' | 'FAILED'
  reason: string | null
}

/**
 * Sends a document (e.g. a payslip) through an approved document-header
 * template and records the attempt either way, same as `deliver` for a
 * plain body-only template. Never throws.
 */
export async function deliverDocument(input: DocumentDeliveryInput): Promise<DocumentDeliveryResult> {
  const draft: OutboxDraft = {
    organizationId: input.organizationId,
    employeeId: input.employeeId,
    recipientPhone: normalisePhone(input.recipientPhone),
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
    variables: input.variables,
    preview: input.preview,
  }

  if (!draft.recipientPhone) {
    const reason = 'No usable mobile number on record'
    await recordOutbox(draft, 'SKIPPED', reason, null)
    return { status: 'SKIPPED', reason }
  }

  try {
    const result = await whatsapp.sendDocument({
      to: draft.recipientPhone,
      templateName: input.templateName,
      languageCode: input.templateLanguage,
      variables: input.variables,
      documentBuffer: input.documentBuffer,
      documentMimeType: input.documentMimeType,
      filename: input.filename,
    })
    await recordOutbox(draft, 'SENT', whatsappIsLive() ? null : (result.detail ?? null), result.providerMessageId)
    return { status: 'SENT', reason: null }
  } catch (error) {
    const reason =
      error instanceof WhatsAppSendError ? error.message : 'The message could not be sent. See the server log.'
    logger.warn({ err: error, employeeId: input.employeeId }, 'WhatsApp document delivery failed')
    await recordOutbox(draft, 'FAILED', reason, null)
    return { status: 'FAILED', reason }
  }
}

interface RecipientContact {
  userId: string | null
  employeeId: string | null
  fullName: string
  phone: string | null
}

async function contactForUser(userId: string, db: Queryable = pool): Promise<RecipientContact | null> {
  return queryOne<RecipientContact>(
    db,
    `SELECT u.id AS "userId",
            e.id AS "employeeId",
            COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), u.full_name) AS "fullName",
            COALESCE(e.mobile_number, u.phone) AS phone
       FROM users u
       LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.id = $1 AND u.status = 'ACTIVE'`,
    [userId],
  )
}

/**
 * Fires the WhatsApp side of a notification.
 *
 * Called from the notification service so every existing trigger point is
 * covered without touching its call site. Never throws.
 */
export async function dispatchScenario(params: {
  organizationId: string
  eventKey: string
  userId: string
  title: string
  body: string
}): Promise<void> {
  try {
    const scenario = await queryOne<ScenarioRow>(
      pool,
      'SELECT * FROM message_scenarios WHERE organization_id = $1 AND event_key = $2',
      [params.organizationId, params.eventKey],
    )
    // Off, or never configured: nothing to do and nothing to log.
    if (!scenario || !scenario.whatsapp_enabled) return

    const contact = await contactForUser(params.userId)
    if (!contact) return

    const values: Record<string, string> = {
      recipientName: contact.fullName.trim(),
      title: params.title,
      body: params.body,
    }
    const names = (scenario.template_variables as string[]) ?? []

    await deliver({
      organizationId: params.organizationId,
      eventKey: params.eventKey,
      userId: contact.userId,
      employeeId: contact.employeeId,
      recipientPhone: normalisePhone(contact.phone),
      templateName: scenario.template_name,
      templateLanguage: scenario.template_language,
      variables: names.map((name) => values[name] ?? ''),
      preview: `${params.title} — ${params.body}`,
    })
  } catch (error) {
    // A courtesy message must never break the operation that triggered it.
    logger.warn({ err: error, event: params.eventKey }, 'Could not dispatch a WhatsApp scenario')
  }
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

export interface BroadcastInput {
  title: string
  body: string
  userIds: string[]
  sendInApp: boolean
  sendWhatsapp: boolean
  templateName?: string | null
  templateLanguage?: string
  templateVariables?: string[]
}

const BROADCAST_VARIABLES = new Set(['recipientName', 'title', 'body'])

export async function sendBroadcast(
  organizationId: string,
  input: BroadcastInput,
  context: AuditContext,
) {
  if (input.userIds.length === 0) throw ApiError.badRequest('Choose at least one recipient')
  if (!input.sendInApp && !input.sendWhatsapp) throw ApiError.badRequest('Choose at least one channel')
  if (input.sendWhatsapp && !input.templateName) {
    throw ApiError.businessRule(
      'A WhatsApp broadcast needs an approved template name — free-form business-initiated messages are refused by WhatsApp.',
    )
  }

  const variables = input.templateVariables ?? ['recipientName', 'title', 'body']
  const unknown = variables.filter((name) => !BROADCAST_VARIABLES.has(name))
  if (unknown.length > 0) throw ApiError.badRequest(`Unknown variable: ${unknown.join(', ')}`)

  const broadcast = await queryOne<{ id: string }>(
    pool,
    `INSERT INTO message_broadcasts
       (organization_id, title, body, template_name, template_language, template_variables,
        send_in_app, send_whatsapp, recipient_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
     RETURNING id`,
    [
      organizationId,
      input.title,
      input.body,
      input.templateName ?? null,
      input.templateLanguage ?? 'en',
      JSON.stringify(variables),
      input.sendInApp,
      input.sendWhatsapp,
      input.userIds.length,
      context.userId,
    ],
  )
  const broadcastId = broadcast?.id as string

  let sent = 0
  let failed = 0

  for (const userId of input.userIds) {
    const contact = await contactForUser(userId)
    if (!contact) {
      failed += 1
      continue
    }

    if (input.sendInApp) {
      await pool
        .query(
          `INSERT INTO notifications (organization_id, user_id, type, title, body, metadata)
           VALUES ($1, $2, 'GENERAL', $3, $4, $5::jsonb)`,
          [organizationId, userId, input.title, input.body, JSON.stringify({ broadcastId })],
        )
        .catch((error: unknown) => logger.warn({ err: error }, 'Could not write a broadcast notification'))
    }

    if (input.sendWhatsapp) {
      const values: Record<string, string> = {
        recipientName: contact.fullName.trim(),
        title: input.title,
        body: input.body,
      }
      const ok = await deliver({
        organizationId,
        broadcastId,
        userId: contact.userId,
        employeeId: contact.employeeId,
        recipientPhone: normalisePhone(contact.phone),
        templateName: input.templateName ?? null,
        templateLanguage: input.templateLanguage ?? 'en',
        variables: variables.map((name) => values[name] ?? ''),
        preview: `${input.title} — ${input.body}`,
      })
      if (ok) sent += 1
      else failed += 1
    } else {
      sent += 1
    }
  }

  await pool.query('UPDATE message_broadcasts SET sent_count = $2, failed_count = $3 WHERE id = $1', [
    broadcastId,
    sent,
    failed,
  ])

  await recordAudit({
    ...context,
    action: 'MESSAGE_BROADCAST_SENT',
    entityType: 'message_broadcast',
    entityId: broadcastId,
    newValues: { title: input.title, recipients: input.userIds.length, sent, failed },
  })

  return { id: broadcastId, recipientCount: input.userIds.length, sentCount: sent, failedCount: failed }
}

export async function listBroadcasts(organizationId: string) {
  const rows = await queryRows<{
    id: string
    title: string
    body: string
    template_name: string | null
    send_in_app: boolean
    send_whatsapp: boolean
    recipient_count: number
    sent_count: number
    failed_count: number
    created_at: Date
    created_by_name: string | null
  }>(
    pool,
    `SELECT b.*, u.full_name AS created_by_name
       FROM message_broadcasts b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.organization_id = $1
      ORDER BY b.created_at DESC
      LIMIT 50`,
    [organizationId],
  )
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    templateName: row.template_name,
    sendInApp: row.send_in_app,
    sendWhatsapp: row.send_whatsapp,
    recipientCount: row.recipient_count,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }))
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

export async function listOutbox(
  organizationId: string,
  filters: { status?: string; eventKey?: string; page?: number; pageSize?: number },
): Promise<Paginated<unknown>> {
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 25

  const conditions = ['o.organization_id = $1']
  const params: unknown[] = [organizationId]

  if (filters.status) {
    params.push(filters.status)
    conditions.push(`o.status = $${params.length}::message_status`)
  }
  if (filters.eventKey) {
    params.push(filters.eventKey)
    conditions.push(`o.event_key = $${params.length}`)
  }

  const where = conditions.join(' AND ')
  const totalRow = await queryOne<{ count: string }>(
    pool,
    `SELECT COUNT(*)::text AS count FROM message_outbox o WHERE ${where}`,
    params,
  )

  const rows = await queryRows<{
    id: string
    event_key: string | null
    recipient_phone: string | null
    template_name: string | null
    preview: string | null
    status: string
    status_reason: string | null
    created_at: Date
    recipient_name: string | null
  }>(
    pool,
    `SELECT o.*, COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), u.full_name) AS recipient_name
       FROM message_outbox o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN employees e ON e.id = o.employee_id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT ${pageSize} OFFSET ${offsetOf(page, pageSize)}`,
    params,
  )

  return buildPaginated(
    rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key,
      recipientName: row.recipient_name?.trim() || null,
      recipientPhone: row.recipient_phone,
      templateName: row.template_name,
      preview: row.preview,
      status: row.status,
      statusReason: row.status_reason,
      createdAt: row.created_at,
    })),
    Number(totalRow?.count ?? 0),
    page,
    pageSize,
  )
}
