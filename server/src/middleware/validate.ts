import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError, type ZodTypeAny, type z } from 'zod'
import { ApiError, type ErrorDetail } from '../utils/api-error.js'

export interface ValidationSchemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
}

function toDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
    code: issue.code,
  }))
}

/**
 * Validates and replaces `body`, `query` and `params` with the parsed values, so
 * controllers receive typed, coerced data. Backend validation is mandatory
 * regardless of what the client checked (plan section 54).
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params']
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query) as Record<string, unknown>
        // Express 4 exposes `query` as a plain property, but re-assigning keeps
        // downstream code reading the coerced values.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true })
      }
      if (schemas.body) req.body = schemas.body.parse(req.body) as unknown
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        next(ApiError.badRequest('Request validation failed', toDetails(error)))
        return
      }
      next(error)
    }
  }
}

/** Parses a value against a schema, converting Zod failures into an ApiError. */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, message = 'Validation failed'): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw ApiError.badRequest(message, toDetails(result.error))
  }
  return result.data
}
