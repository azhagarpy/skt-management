import { pino } from 'pino'
import { env, isProduction } from '../config/env.js'

/**
 * Sensitive fields are redacted so payroll/identity data never reaches the logs.
 * See plan section 53 (Data privacy): "No sensitive information in application logs".
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.aadhaarNumber',
  '*.aadhaar_number',
  '*.panNumber',
  '*.pan_number',
  '*.accountNumber',
  '*.account_number',
]

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  ...(isProduction ? {} : { transport: { target: 'pino/file', options: { destination: 1 } } }),
})

export type Logger = typeof logger
