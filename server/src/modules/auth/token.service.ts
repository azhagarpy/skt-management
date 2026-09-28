import { createHash, randomBytes } from 'node:crypto'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { ApiError } from '../../utils/api-error.js'
import type { RoleKey } from './permissions.js'

export interface AccessTokenPayload {
  sub: string
  organizationId: string
  role: RoleKey
  employeeId: string | null
  /** Bumped whenever the password changes, invalidating older access tokens. */
  tokenVersion: number
  /**
   * True until the app lock PIN is entered. A locked token reaches only the
   * unlock endpoint (see `authenticate`).
   */
  pinLocked?: boolean
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] }
  return jwt.sign(payload, env.JWT_SECRET, options)
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload
  } catch (error) {
    const message = (error as Error).name === 'TokenExpiredError' ? 'Session expired' : 'Invalid access token'
    throw ApiError.unauthenticated(message)
  }
}

/**
 * Reads an access token whose signature is valid, even if it has expired, or
 * returns null. Refresh uses it to learn whether the page asking already
 * unlocked the app, so a routine refresh does not lock an open page again.
 */
export function readAccessTokenIgnoringExpiry(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET, { ignoreExpiration: true }) as AccessTokenPayload
  } catch {
    return null
  }
}

/**
 * Refresh tokens are opaque random strings. Only their SHA-256 hash is stored, so
 * a database leak does not hand out usable sessions.
 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Converts a duration such as `15m`, `7d` or `3600` into milliseconds. */
export function durationToMs(duration: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)?$/i.exec(duration.trim())
  if (!match) throw new Error(`Unsupported duration: ${duration}`)
  const value = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return value * (multipliers[unit] ?? 1_000)
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + durationToMs(env.REFRESH_TOKEN_EXPIRES_IN))
}

export function passwordResetExpiry(): Date {
  return new Date(Date.now() + durationToMs(env.PASSWORD_RESET_TOKEN_EXPIRES_IN))
}
