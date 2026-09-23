import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'

/**
 * WhatsApp delivery.
 *
 * Mirrors the storage driver: an interface with a driver chosen by
 * configuration, so nothing above this file knows which provider is in use.
 * The `log` driver records a message without sending it, which makes the whole
 * notification path exercisable without an account; `meta` talks to the
 * WhatsApp Cloud API over plain HTTPS and needs no SDK.
 *
 * WhatsApp refuses free-form business-initiated messages: anything sent outside
 * the 24-hour window after a user writes to us must use a template the provider
 * has already approved. That is why this interface takes a template name and
 * ordered variables rather than a body string.
 */

export interface SendTemplateInput {
  /** E.164 digits, no plus sign, e.g. 919845010001. */
  to: string
  templateName: string
  languageCode: string
  /** Fills {{1}}, {{2}}, ... in the approved template, in order. */
  variables: string[]
}

/**
 * A document sent through a template that has a document header (the only way
 * to send a file outside the 24-hour session window - see the module note
 * above). The org sets this template up once in WhatsApp Business Manager;
 * this only fills it in.
 */
export interface SendDocumentInput {
  to: string
  templateName: string
  languageCode: string
  /** Fills the template body's {{1}}, {{2}}, ... in order. */
  variables: string[]
  documentBuffer: Buffer
  documentMimeType: string
  filename: string
}

export interface SendResult {
  providerMessageId: string | null
  /** Human-readable, and safe to show an administrator. */
  detail?: string
}

export interface WhatsAppDriver {
  readonly name: string
  send(input: SendTemplateInput): Promise<SendResult>
  sendDocument(input: SendDocumentInput): Promise<SendResult>
}

/** Raised when the provider rejects a message; carries a message fit for an admin. */
export class WhatsAppSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhatsAppSendError'
  }
}

/**
 * Reduces a stored number to the digits WhatsApp expects. Numbers kept as
 * "+91 98450 10001" or "098450 10001" are both common in employee records.
 */
export function normalisePhone(raw: string | null | undefined, defaultCountryCode = env.WHATSAPP_DEFAULT_COUNTRY_CODE): string | null {
  if (!raw) return null
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return null

  // A single leading zero is a domestic trunk prefix, not part of the number.
  digits = digits.replace(/^0+/, '')
  if (digits.length === 0) return null

  // Already carries a country code if it is longer than a local subscriber number.
  if (digits.length <= 10 && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits}`
  }

  // E.164 allows at most 15 digits; anything longer is a data-entry error.
  if (digits.length < 8 || digits.length > 15) return null
  return digits
}

/**
 * WhatsApp rejects a template parameter that is empty or contains line breaks,
 * tabs or runs of spaces, and a notification body can contain all of those.
 */
function templateParameter(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned === '' ? '-' : cleaned
}

const logDriver: WhatsAppDriver = {
  name: 'log',
  async send(input) {
    logger.info(
      {
        to: input.to,
        template: input.templateName,
        language: input.languageCode,
        variables: input.variables,
      },
      'WhatsApp message recorded (log driver - nothing was sent)',
    )
    return { providerMessageId: null, detail: 'Recorded by the log driver; no message was sent' }
  },
  async sendDocument(input) {
    logger.info(
      {
        to: input.to,
        template: input.templateName,
        language: input.languageCode,
        filename: input.filename,
        bytes: input.documentBuffer.length,
      },
      'WhatsApp document recorded (log driver - nothing was sent)',
    )
    return { providerMessageId: null, detail: 'Recorded by the log driver; no document was sent' }
  },
}

/** A hung provider must not hold a request open behind it. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out after 15s' : 'could not be reached'
    throw new WhatsAppSendError(`The WhatsApp API ${reason}`)
  } finally {
    clearTimeout(timeout)
  }
}

function assertMetaConfigured(): void {
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    throw new WhatsAppSendError(
      'WhatsApp is set to the Meta driver but WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is missing',
    )
  }
}

/** Uploads a file to the phone number's media library, returning its media id. */
async function uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`
  const form = new FormData()
  form.set('messaging_product', 'whatsapp')
  form.set('type', mimeType)
  form.set('file', new Blob([buffer], { type: mimeType }), filename)

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  })
  const payload = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null

  if (!response.ok || !payload?.id) {
    throw new WhatsAppSendError(`WhatsApp rejected the document upload: ${payload?.error?.message ?? `HTTP ${response.status}`}`)
  }
  return payload.id
}

/** Posts a prepared template message body and returns the provider's message id. */
async function sendTemplateMessage(body: Record<string, unknown>): Promise<SendResult> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const payload = (await response.json().catch(() => null)) as
    | { messages?: { id: string }[]; error?: { message?: string; code?: number } }
    | null

  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`
    throw new WhatsAppSendError(`WhatsApp rejected the message: ${detail}`)
  }

  return { providerMessageId: payload?.messages?.[0]?.id ?? null }
}

const metaDriver: WhatsAppDriver = {
  name: 'meta',
  async send(input) {
    assertMetaConfigured()
    return sendTemplateMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components:
          input.variables.length > 0
            ? [
                {
                  type: 'body',
                  parameters: input.variables.map((value) => ({ type: 'text', text: templateParameter(value) })),
                },
              ]
            : [],
      },
    })
  },
  async sendDocument(input) {
    assertMetaConfigured()
    const mediaId = await uploadMedia(input.documentBuffer, input.documentMimeType, input.filename)

    return sendTemplateMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'document', document: { id: mediaId, filename: input.filename } }],
          },
          ...(input.variables.length > 0
            ? [
                {
                  type: 'body',
                  parameters: input.variables.map((value) => ({ type: 'text', text: templateParameter(value) })),
                },
              ]
            : []),
        ],
      },
    })
  },
}

export const whatsapp: WhatsAppDriver = env.WHATSAPP_DRIVER === 'meta' ? metaDriver : logDriver

/** True when messages will actually leave the building. */
export function whatsappIsLive(): boolean {
  return env.WHATSAPP_DRIVER === 'meta' && Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN)
}

export function whatsappStatus(): { driver: string; live: boolean; detail: string } {
  if (env.WHATSAPP_DRIVER !== 'meta') {
    return {
      driver: env.WHATSAPP_DRIVER,
      live: false,
      detail: 'Messages are recorded in the delivery log but not sent. Set WHATSAPP_DRIVER=meta to deliver.',
    }
  }
  if (!whatsappIsLive()) {
    return {
      driver: 'meta',
      live: false,
      detail: 'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must both be set before messages can be sent.',
    }
  }
  return { driver: 'meta', live: true, detail: 'Connected to the WhatsApp Cloud API.' }
}
