-- +migrate Up
-- Core identity, tenancy, RBAC, settings, auditing and notifications.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Shared enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE');
CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'LOCKED');
CREATE TYPE verification_status AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- Shared trigger: keeps updated_at honest without relying on application code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  legal_name        TEXT,
  code              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  website           TEXT,
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  state             TEXT,
  country           TEXT NOT NULL DEFAULT 'India',
  pincode           TEXT,
  tax_id            TEXT,
  registration_no   TEXT,
  logo_path         TEXT,
  currency_code     TEXT NOT NULL DEFAULT 'INR',
  timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizations_code_key UNIQUE (code)
);

CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- RBAC: roles carry a default permission set, users may be granted or denied
-- individual permissions on top of their role (plan sections 3 and 38).
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL,
  description  TEXT NOT NULL,
  module       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permissions_code_key UNIQUE (code)
);

CREATE TABLE roles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID REFERENCES organizations (id) ON DELETE CASCADE,
  key              user_role NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  is_system        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roles_org_key_unique UNIQUE (organization_id, key)
);

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id        UUID NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id  UUID NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  user_role NOT NULL,
  status                user_status NOT NULL DEFAULT 'ACTIVE',
  full_name             TEXT NOT NULL,
  phone                 TEXT,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at         TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_organization_id_idx ON users (organization_id);
CREATE INDEX users_role_idx ON users (organization_id, role);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-user permission overrides. `granted = false` removes a permission the role
-- would otherwise imply, which is how "supervisor may view team salary only if
-- explicitly permitted" is modelled (plan section 3).
CREATE TABLE user_permissions (
  user_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission_id  UUID NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  granted        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Sessions / tokens
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent   TEXT,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_hash_key UNIQUE (token_hash)
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_key UNIQUE (token_hash)
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

-- ---------------------------------------------------------------------------
-- System settings: every configurable rule lives here rather than in code
-- (plan sections 16, 17, 23, 68 - "no hard-coded statutory rates").
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  category         TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            JSONB NOT NULL,
  description      TEXT,
  updated_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT system_settings_unique UNIQUE (organization_id, category, key)
);

CREATE INDEX system_settings_organization_id_idx ON system_settings (organization_id);

CREATE TRIGGER system_settings_set_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (plan section 40)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID REFERENCES organizations (id) ON DELETE SET NULL,
  user_id          UUID REFERENCES users (id) ON DELETE SET NULL,
  action           TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        UUID,
  old_values       JSONB,
  new_values       JSONB,
  ip_address       TEXT,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_organization_id_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_user_id_idx ON audit_logs (user_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

-- ---------------------------------------------------------------------------
-- Notifications (plan section 44)
-- ---------------------------------------------------------------------------
CREATE TYPE notification_type AS ENUM (
  'LEAVE_REQUEST_SUBMITTED',
  'LEAVE_REQUEST_APPROVED',
  'LEAVE_REQUEST_REJECTED',
  'LEAVE_REQUEST_CANCELLED',
  'DOCUMENT_VERIFIED',
  'DOCUMENT_REJECTED',
  'DOCUMENT_UPLOADED',
  'PAYROLL_APPROVED',
  'PAYROLL_LOCKED',
  'PAYSLIP_AVAILABLE',
  'PAYMENT_RECORDED',
  'PROFILE_INCOMPLETE',
  'GENERAL'
);

CREATE TABLE notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type             notification_type NOT NULL DEFAULT 'GENERAL',
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  link             TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_id_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- +migrate Down
DROP TABLE IF EXISTS notifications;
DROP TYPE IF EXISTS notification_type;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS system_settings;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS user_permissions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS organizations;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS verification_status;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS user_role;
