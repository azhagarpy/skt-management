import 'dotenv/config'
import { z } from 'zod'

const bool = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())))

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_SECRET: z.string().min(16, 'REFRESH_TOKEN_SECRET must be at least 16 characters'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  PASSWORD_RESET_TOKEN_EXPIRES_IN: z.string().default('30m'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  STORAGE_ENDPOINT: z.string().optional().default(''),
  STORAGE_BUCKET: z.string().optional().default(''),
  STORAGE_ACCESS_KEY: z.string().optional().default(''),
  STORAGE_SECRET_KEY: z.string().optional().default(''),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),

  /**
   * WhatsApp delivery. The `log` driver records messages without sending, so
   * the whole flow is exercisable without an account; `meta` talks to the
   * WhatsApp Cloud API over plain HTTPS and needs no SDK.
   */
  WHATSAPP_DRIVER: z.enum(['log', 'meta']).default('log'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  /** Digits prefixed to a local mobile number that has no country code. */
  WHATSAPP_DEFAULT_COUNTRY_CODE: z.string().default('91'),
  /**
   * The approved template used to send a payslip PDF. It must have a document
   * header (set up once in WhatsApp Business Manager) - there is no way to send
   * a file outside the 24-hour session window without one.
   */
  WHATSAPP_PAYSLIP_TEMPLATE_NAME: z.string().default('skt_payslip_document'),
  WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE: z.string().default('en'),

  REDIS_URL: z.string().optional().default(''),
  SEED_DEFAULT_PASSWORD: z.string().default('Passw0rd!123'),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

export const env = loadEnv()
export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
