import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import { env, isProduction } from './config/env.js'
import { logger } from './utils/logger.js'
import { sendSuccess } from './utils/http.js'
import { errorHandler } from './middleware/error-handler.js'
import { notFoundHandler } from './middleware/not-found.js'
import { apiRouter } from './routes.js'

export function createApp(): Express {
  const app = express()

  // Behind nginx/a load balancer, so req.ip reflects the real client.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      // Documents are streamed as attachments; stop browsers guessing types.
      noSniff: true,
    }),
  )

  const allowedOrigins = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients send no Origin header.
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true)
          return
        }
        callback(new Error('Origin not allowed by CORS'))
      },
      credentials: true,
      maxAge: 600,
    }),
  )

  app.use(compression())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))
  app.use(cookieParser())

  app.use((req, _res, next) => {
    req.requestId = req.get('x-request-id') ?? randomUUID()
    next()
  })

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? randomUUID(),
      customLogLevel(_req, res, error) {
        if (error || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return 'info'
      },
      // Health checks would otherwise dominate the log.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/v1/health' },
    }),
  )

  // A broad ceiling on API traffic; individual routers add tighter limits.
  app.use(
    env.API_PREFIX,
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down', details: [] },
      },
    }),
  )

  app.get('/health', (_req, res) => {
    sendSuccess(res, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) })
  })

  app.use(env.API_PREFIX, apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
