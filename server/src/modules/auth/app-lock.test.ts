import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { authenticate } from '../../middleware/authenticate.js'
import { ApiError } from '../../utils/api-error.js'
import type { UserWithEmployee } from './auth.repository.js'
import { refreshNeedsPin } from './auth.service.js'
import { signAccessToken } from './token.service.js'
import { unlockPinSchema } from './auth.validation.js'

/**
 * The app lock: a PIN asked for each time the site is opened, but not on the
 * routine refreshes an open page makes while someone is using it.
 */

const PASSWORD_CHANGED_AT = new Date('2026-09-01T10:00:00Z')
const VERSION = Math.floor(PASSWORD_CHANGED_AT.getTime() / 1000)

function user(overrides: Partial<UserWithEmployee> = {}): UserWithEmployee {
  return {
    id: 'user-1',
    organization_id: 'org-1',
    email: 'sup@example.com',
    password_hash: 'x',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    full_name: 'Sup',
    phone: null,
    must_change_password: false,
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: null,
    password_changed_at: PASSWORD_CHANGED_AT,
    app_pin_hash: '$2a$04$hash',
    app_pin_failed_attempts: 0,
    employee_id: 'emp-1',
    employee_code: 'SENT0001',
    ...overrides,
  }
}

const tokenFor = (claims: { sub?: string; pinLocked?: boolean; tokenVersion?: number; expired?: boolean } = {}) =>
  jwt.sign(
    {
      sub: claims.sub ?? 'user-1',
      organizationId: 'org-1',
      role: 'SUPERVISOR',
      employeeId: 'emp-1',
      tokenVersion: claims.tokenVersion ?? VERSION,
      ...(claims.pinLocked ? { pinLocked: true } : {}),
      exp: Math.floor(Date.now() / 1000) + (claims.expired ? -600 : 600),
    },
    env.JWT_SECRET,
  )

describe('refreshNeedsPin', () => {
  it('never locks an account without a PIN', () => {
    expect(refreshNeedsPin(user({ app_pin_hash: null }), undefined)).toBe(false)
  })

  it('locks a page that was just opened, which has no access token yet', () => {
    expect(refreshNeedsPin(user(), undefined)).toBe(true)
  })

  it('keeps an open, unlocked page unlocked across a routine refresh, even once its token has expired', () => {
    expect(refreshNeedsPin(user(), tokenFor())).toBe(false)
    expect(refreshNeedsPin(user(), tokenFor({ expired: true }))).toBe(false)
  })

  it('keeps a locked page locked', () => {
    expect(refreshNeedsPin(user(), tokenFor({ pinLocked: true }))).toBe(true)
  })

  it('does not accept another user’s token, a token from before a password change, or a forged one', () => {
    expect(refreshNeedsPin(user(), tokenFor({ sub: 'user-2' }))).toBe(true)
    expect(refreshNeedsPin(user(), tokenFor({ tokenVersion: VERSION - 1 }))).toBe(true)
    expect(refreshNeedsPin(user(), jwt.sign({ sub: 'user-1', tokenVersion: VERSION }, 'not-the-real-secret'))).toBe(true)
    expect(refreshNeedsPin(user(), 'garbage')).toBe(true)
  })
})

describe('authenticate', () => {
  const run = (token: string): Promise<unknown> =>
    new Promise((resolve) => {
      const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as unknown as Request
      void authenticate(req, {} as Response, ((error?: unknown) => resolve(error)) as NextFunction)
    })

  it('refuses a session still waiting for its PIN, before touching the database', async () => {
    const error = await run(
      signAccessToken({ sub: 'user-1', organizationId: 'org-1', role: 'SUPERVISOR', employeeId: null, tokenVersion: 1, pinLocked: true }),
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ statusCode: 423, code: 'APP_LOCKED' })
  })
})

describe('PIN format', () => {
  it('takes exactly four digits, leading zero included', () => {
    expect(unlockPinSchema.safeParse({ pin: '0427' }).success).toBe(true)
    for (const pin of ['123', '12345', '12a4', ' 1234', '']) {
      expect(unlockPinSchema.safeParse({ pin }).success).toBe(false)
    }
  })
})
