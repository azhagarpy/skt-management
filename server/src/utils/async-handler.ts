import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Wraps an async controller so rejected promises reach the global error handler
 * instead of hanging the request.
 */
export function asyncHandler<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req as T, res, next).catch(next)
  }
}
