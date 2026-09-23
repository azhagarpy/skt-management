import type { Response } from 'express'
import type { ErrorCode, ErrorDetail } from './api-error.js'

export interface SuccessBody<T> {
  success: true
  data: T
  message?: string
  meta?: Record<string, unknown>
}

export interface ErrorBody {
  success: false
  error: {
    code: ErrorCode
    message: string
    details: ErrorDetail[]
  }
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode = 200,
  meta?: Record<string, unknown>,
): Response {
  const body: SuccessBody<T> = { success: true, data }
  if (message) body.message = message
  if (meta) body.meta = meta
  return res.status(statusCode).json(body)
}

export function sendCreated<T>(res: Response, data: T, message?: string): Response {
  return sendSuccess(res, data, message, 201)
}

export function sendNoContent(res: Response, message = 'Deleted successfully'): Response {
  return sendSuccess(res, null, message, 200)
}
