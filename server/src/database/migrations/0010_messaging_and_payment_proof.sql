-- +migrate Up
-- WhatsApp messaging, and proof of payment.
--
-- Two unrelated-looking features share a migration because both are about
-- evidence: what the business told someone, and what it can show for a payment
-- made outside the banking rails.

-- ---------------------------------------------------------------------------
-- Message scenarios
--
-- One row per notifiable event. WhatsApp refuses free-form business-initiated
-- messages, so a scenario does not carry body text: it carries the name of a
-- template already approved by the provider, plus the ordered list of the
-- event's variables that fill that template's placeholders.
-- ---------------------------------------------------------------------------
CREATE TABLE message_scenarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- Matches a NotificationType in the application.
  event_key        TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  template_name    TEXT,
  template_language TEXT NOT NULL DEFAULT 'en',
  -- Ordered variable names, e.g. ["employeeName","leaveDates"]. Position in
  -- this array is the template's {{1}}, {{2}}, ...
  template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_scenarios_unique UNIQUE (organization_id, event_key)
);

CREATE INDEX message_scenarios_org_idx ON message_scenarios (organization_id);
CREATE TRIGGER message_scenarios_set_updated_at BEFORE UPDATE ON message_scenarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Broadcasts
--
-- An admin-initiated message to a chosen set of people. Recorded as its own
-- row so the audience and the template used stay auditable after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE message_broadcasts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  template_name     TEXT,
  template_language TEXT NOT NULL DEFAULT 'en',
  template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  send_in_app       BOOLEAN NOT NULL DEFAULT TRUE,
  send_whatsapp     BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_count   INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  sent_count        INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count      INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX message_broadcasts_org_idx ON message_broadcasts (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Outbox
--
-- Every WhatsApp message the system attempts, whether or not it left the
-- building. This is the delivery log the admin screen reads, and the reason a
-- failed send never has to be reconstructed from application logs.
-- ---------------------------------------------------------------------------
CREATE TYPE message_status AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE message_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  channel             TEXT NOT NULL DEFAULT 'WHATSAPP',
  event_key           TEXT,
  broadcast_id        UUID REFERENCES message_broadcasts (id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users (id) ON DELETE SET NULL,
  employee_id         UUID REFERENCES employees (id) ON DELETE SET NULL,
  -- Stored as sent, so a later change to the employee's number does not
  -- rewrite history.
  recipient_phone     TEXT,
  template_name       TEXT,
  template_language   TEXT,
  template_variables  JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview             TEXT,
  status              message_status NOT NULL DEFAULT 'QUEUED',
  -- Why a message was skipped or failed, in words fit to show an admin.
  status_reason       TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

CREATE INDEX message_outbox_org_idx ON message_outbox (organization_id, created_at DESC);
CREATE INDEX message_outbox_status_idx ON message_outbox (organization_id, status);
CREATE INDEX message_outbox_broadcast_idx ON message_outbox (broadcast_id);

-- ---------------------------------------------------------------------------
-- Proof of payment
--
-- Cash and offline transfers have no bank record to point at, so a payment may
-- carry a scanned receipt. The file lives in object storage like every other
-- upload; only its key and type are kept here. `reference_number` already
-- holds the transaction id and stays the unique key it always was.
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_payment_transactions
  ADD COLUMN proof_path        TEXT,
  ADD COLUMN proof_filename    TEXT,
  ADD COLUMN proof_mime_type   TEXT
    CONSTRAINT payroll_payment_proof_mime_type
    CHECK (proof_mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  ADD COLUMN proof_uploaded_at TIMESTAMPTZ,
  ADD COLUMN proof_uploaded_by UUID REFERENCES users (id) ON DELETE SET NULL;

-- +migrate Down
ALTER TABLE payroll_payment_transactions
  DROP COLUMN IF EXISTS proof_uploaded_by,
  DROP COLUMN IF EXISTS proof_uploaded_at,
  DROP COLUMN IF EXISTS proof_mime_type,
  DROP COLUMN IF EXISTS proof_filename,
  DROP COLUMN IF EXISTS proof_path;

DROP TABLE IF EXISTS message_outbox;
DROP TYPE IF EXISTS message_status;
DROP TABLE IF EXISTS message_broadcasts;
DROP TABLE IF EXISTS message_scenarios;
