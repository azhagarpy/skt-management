import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../middleware/validate.js'
import { authenticate } from '../../middleware/authenticate.js'
import * as controller from './auth.controller.js'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
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
