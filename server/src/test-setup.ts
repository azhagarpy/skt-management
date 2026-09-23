/**
 * Test bootstrap.
 *
 * The configuration module validates the environment at import time, which is
 * what makes a misconfigured deployment fail loudly at startup. Unit tests do
 * not talk to PostgreSQL, so they supply throwaway values here rather than
 * weakening that validation.
 */
process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test'
process.env.JWT_SECRET ??= 'test-access-secret-at-least-16-chars'
process.env.REFRESH_TOKEN_SECRET ??= 'test-refresh-secret-at-least-16-chars'
process.env.LOG_LEVEL ??= 'silent'
// Keep hashing cheap so the suite stays fast; production uses the configured cost.
process.env.BCRYPT_ROUNDS ??= '4'
