-- +migrate Up
-- Employee photo metadata. `photo_path` already exists on `employees`; this
-- adds the mime type and update timestamp needed to stream and cache-bust it
-- the same way the organization logo already works (see 0009_org_branding.sql).

ALTER TABLE employees
  ADD COLUMN photo_mime_type  TEXT
    CONSTRAINT employees_photo_mime_type CHECK (photo_mime_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN photo_updated_at TIMESTAMPTZ;

-- +migrate Down
ALTER TABLE employees
  DROP COLUMN IF EXISTS photo_updated_at,
  DROP COLUMN IF EXISTS photo_mime_type;
