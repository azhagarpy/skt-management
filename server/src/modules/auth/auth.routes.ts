import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../middleware/validate.js'
import { authenticate, authenticateLocked } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { PERMISSIONS } from './permissions.js'
import * as controller from './auth.controller.js'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  removePinSchema,
  resetPasswordSchema,
  setPinSchema,
  unlockPinSchema,
} from './auth.validation.js'

/**
 * Credential endpoints are rate limited per IP to blunt password spraying.
 * The limiter counts only failed attempts so a busy office does not lock itself
 * out with successful sign-ins.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later', details: [] },
  },
})

export const authRouter = Router()

authRouter.post('/login', credentialLimiter, validate({ body: loginSchema }), controller.login)
authRouter.post('/refresh', validate({ body: refreshSchema }), controller.refresh)
authRouter.post('/logout', controller.logout)
authRouter.post('/forgot-password', credentialLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword)
authRouter.post('/reset-password', credentialLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword)
authRouter.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword)
authRouter.get('/me', authenticate, controller.me)

// App lock PIN. Unlocking accepts a locked session - that is its whole point -
// and is also held to the per-IP limit on top of the per-user count of wrong PINs.
authRouter.post('/pin/unlock', credentialLimiter, authenticateLocked, validate({ body: unlockPinSchema }), controller.unlockPin)
authRouter.put(
  '/pin',
  credentialLimiter,
  authenticate,
  requirePermissions(PERMISSIONS.APP_LOCK_MANAGE),
  validate({ body: setPinSchema }),
  controller.setPin,
)
// Turning the lock off needs no permission, so losing the permission never strands a PIN.
authRouter.post('/pin/remove', credentialLimiter, authenticate, validate({ body: removePinSchema }), controller.removePin)
