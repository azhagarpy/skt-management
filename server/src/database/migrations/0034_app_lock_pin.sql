-- +migrate Up
-- App lock: an optional 4-digit PIN a user must enter each time the site is
-- opened on a device where they are still signed in. Only the bcrypt hash is
-- kept. A NULL hash means the lock is off.
ALTER TABLE users
  ADD COLUMN app_pin_hash TEXT,
  ADD COLUMN app_pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN app_pin_updated_at TIMESTAMPTZ;

-- +migrate Down
ALTER TABLE users
  DROP COLUMN IF EXISTS app_pin_updated_at,
  DROP COLUMN IF EXISTS app_pin_failed_attempts,
  DROP COLUMN IF EXISTS app_pin_hash;
