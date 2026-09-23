-- +migrate Up
-- Organization branding (name, logo and accent colour).
--
-- The app chrome reads its identity from the organization row rather than from
-- hard-coded constants, so a super admin can rebrand the product without a
-- deploy. The logo itself lives in object storage like any other upload; only
-- its key and content type are kept here.

ALTER TABLE organizations
  ADD COLUMN theme_color     TEXT NOT NULL DEFAULT '#5b54d6'
    CONSTRAINT organizations_theme_color_hex CHECK (theme_color ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN logo_mime_type  TEXT
    CONSTRAINT organizations_logo_mime_type CHECK (logo_mime_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN logo_updated_at TIMESTAMPTZ;

-- +migrate Down
ALTER TABLE organizations
  DROP COLUMN IF EXISTS logo_updated_at,
  DROP COLUMN IF EXISTS logo_mime_type,
  DROP COLUMN IF EXISTS theme_color;
