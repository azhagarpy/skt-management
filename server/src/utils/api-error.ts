export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE_ERROR'
  | 'PAYROLL_ERROR'
  | 'PAYMENT_ERROR'
  | 'FILE_UPLOAD_ERROR'
  | 'RATE_LIMITED'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR'

export interface ErrorDetail {
  field?: string
  message: string
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details: ErrorDetail[]
  readonly expose: boolean

  constructor(statusCode: number, code: ErrorCode, message: string, details: ErrorDetail[] = [], expose = true) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.expose = expose
    Error.captureStackTrace?.(this, ApiError)
  }

  static badRequest(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(400, 'VALIDATION_ERROR', message, details)
  }

  static unauthenticated(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'UNAUTHENTICATED', message)
  }

  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message)
  }

  static notFound(resource = 'Resource'): ApiError {
    return new ApiError(404, 'NOT_FOUND', `${resource} not found`)
  }

  static conflict(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(409, 'CONFLICT', message, details)
  }

  /** 422 - the request was well formed but violates a domain rule. */
  static businessRule(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(422, 'BUSINESS_RULE_ERROR', message, details)
  }

  static payroll(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(422, 'PAYROLL_ERROR', message, details)
  }

  static payment(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(422, 'PAYMENT_ERROR', message, details)
  }

  static upload(message: string, details: ErrorDetail[] = []): ApiError {
    return new ApiError(400, 'FILE_UPLOAD_ERROR', message, details)
  }

  static internal(message = 'Something went wrong'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message, [], false)
  }
}
