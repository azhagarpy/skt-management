import type { Request, Response } from 'express'
import { env, isProduction } from '../../config/env.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/http.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { durationToMs } from './token.service.js'
import * as service from './auth.service.js'
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RefreshInput,
  ResetPasswordInput,
} from './auth.validation.js'

const REFRESH_COOKIE = 'refresh_token'

/**
 * The refresh token is delivered as an httpOnly cookie so it is never readable
 * by page scripts (plan section 53). It is also returned in the body for
 * non-browser clients; browsers should keep using the cookie.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: durationToMs(env.REFRESH_TOKEN_EXPIRES_IN),
  })
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' })
}

function readRefreshToken(req: Request): string | undefined {
  const body = req.body as RefreshInput | undefined
  const cookies = req.cookies as Record<string, string> | undefined
  return body?.refreshToken ?? cookies?.[REFRESH_COOKIE]
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as LoginInput
  const result = await service.login(input, auditContextFrom(req))
  setRefreshCookie(res, result.refreshToken)
  return sendSuccess(
    res,
    {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
    },
    'Signed in successfully',
  )
})

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const token = readRefreshToken(req)
  if (!token) throw ApiError.unauthenticated('No refresh token supplied')
  const result = await service.refresh(token, { userAgent: req.get('user-agent'), ipAddress: req.ip })
  setRefreshCookie(res, result.refreshToken)
  return sendSuccess(
    res,
    {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
    },
    'Session refreshed',
  )
})

export const logout = asyncHandler(async (req: Request, res: Response) => {
  await service.logout(readRefreshToken(req), auditContextFrom(req))
  clearRefreshCookie(res)
  return sendSuccess(res, null, 'Signed out successfully')
})

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordInput
  const result = await service.forgotPassword(email, !isProduction)
  return sendSuccess(
    res,
    result,
    'If an account exists for that address, a password reset link has been sent',
  )
})

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = req.body as ResetPasswordInput
  await service.resetPassword(token, password, auditContextFrom(req))
  clearRefreshCookie(res)
  return sendSuccess(res, null, 'Password reset successfully, please sign in')
})

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const input = req.body as ChangePasswordInput
  await service.changePassword(auth.userId, input, auditContextFrom(req))
  clearRefreshCookie(res)
  return sendSuccess(res, null, 'Password changed successfully, please sign in again')
})

export const me = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const user = await service.currentUser(auth.userId)
  return sendSuccess(res, user)
})
