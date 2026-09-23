import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { ApiError, type ErrorCode, type ErrorDetail } from '../utils/api-error.js'
import { isProduction } from '../config/env.js'
import { logger } from '../utils/logger.js'
import type { ErrorBody } from '../utils/http.js'

interface PostgresError extends Error {
  code?: string
  detail?: string
  constraint?: string
  table?: string
  column?: string
}

/** Maps a PostgreSQL constraint violation onto a user-facing message. */
function translatePostgresError(error: PostgresError): ApiError | null {
  switch (error.code) {
    case '23505': {
      const friendly: Record<string, string> = {
        attendance_employee_date_unique: 'Attendance for this employee and date already exists',
        payroll_items_run_employee_unique: 'This employee already has a payroll item in this run',
        payroll_runs_org_period_unique: 'A payroll run already exists for this month',
        employees_org_code_unique: 'An employee with this code already exists',
        users_email_unique: 'An account with this email already exists',
        employee_leave_balances_unique: 'A leave balance already exists for this type and year',
        payroll_payment_transactions_reference_unique: 'This payment reference number has already been used',
      }
      const message = (error.constraint && friendly[error.constraint]) ?? 'This record already exists'
      return ApiError.conflict(message, error.constraint ? [{ message, constraint: error.constraint }] : [])
    }
    case '23503':
      return ApiError.businessRule('A referenced record does not exist or is still in use')
    case '23514':
      return ApiError.businessRule('A value violates a database rule', [
        { message: error.constraint ?? 'Check constraint violated' },
      ])
    case '23P01':
      return ApiError.conflict('This record overlaps an existing one for the same period')
    case '22P02':
      return ApiError.badRequest('A value has an invalid format')
    case '40001':
    case '40P01':
      return new ApiError(409, 'CONFLICT', 'The operation conflicted with another change, please retry')
    default:
      return null
  }
}

function translateMulterError(error: multer.MulterError): ApiError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return ApiError.upload('The uploaded file is too large')
    case 'LIMIT_UNEXPECTED_FILE':
      return ApiError.upload('Unexpected file field in the upload')
    case 'LIMIT_FILE_COUNT':
      return ApiError.upload('Too many files uploaded at once')
    default:
      return ApiError.upload(error.message)
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof ZodError) {
    const details: ErrorDetail[] = error.issues.map((issue) => ({
      field: issue.path.join('.') || undefined,
      message: issue.message,
    }))
    return ApiError.badRequest('Request validation failed', details)
  }
  if (error instanceof multer.MulterError) return translateMulterError(error)
  if (error && typeof error === 'object' && 'code' in error) {
    const translated = translatePostgresError(error as PostgresError)
    if (translated) return translated
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return ApiError.badRequest('Malformed JSON body')
  }
  return ApiError.internal()
}

/**
 * Global Express error handler (plan section 65).
 *
 * Stack traces and database internals never reach a production response; the
 * full error is logged server side instead.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error)
    return
  }

  const apiError = toApiError(error)
  const logPayload = {
    err: error,
    statusCode: apiError.statusCode,
    code: apiError.code,
    method: req.method,
    path: req.originalUrl,
    userId: req.auth?.userId,
    organizationId: req.auth?.organizationId,
  }

  if (apiError.statusCode >= 500) logger.error(logPayload, 'Unhandled request error')
  else logger.warn(logPayload, 'Request failed')

  const code: ErrorCode = apiError.code
  const body: ErrorBody = {
    success: false,
    error: {
      code,
      message: apiError.expose || !isProduction ? apiError.message : 'Something went wrong',
      details: apiError.details,
    },
  }

  res.status(apiError.statusCode).json(body)
}
