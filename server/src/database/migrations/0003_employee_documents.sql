-- +migrate Up
-- Identity and financial details (plan sections 12-18).
--
-- Every one of these tables is treated as sensitive: values are masked by the API
-- unless the caller holds an explicit "view sensitive data" permission, and the
-- stored files are served only through a permission-checked endpoint.

CREATE TYPE bank_account_type AS ENUM ('SAVINGS', 'CURRENT', 'OTHER');

CREATE TYPE document_category AS ENUM (
  'PAN', 'AADHAAR', 'BANK_PROOF', 'PF', 'ESI', 'PHOTO', 'RESUME',
  'OFFER_LETTER', 'EDUCATION', 'EXPERIENCE', 'CONTRACT', 'LEAVE_ATTACHMENT', 'OTHER'
);

-- ---------------------------------------------------------------------------
-- Stored files. Nothing is ever served from a public URL (plan section 39).
-- ---------------------------------------------------------------------------
CREATE TABLE employee_documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  category             document_category NOT NULL DEFAULT 'OTHER',
  title                TEXT NOT NULL,
  -- Storage key is generated server side; the original name is kept for display only.
  storage_key          TEXT NOT NULL,
  original_filename    TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  file_size_bytes      BIGINT NOT NULL CHECK (file_size_bytes > 0),
  checksum_sha256      TEXT,
  verification_status  verification_status NOT NULL DEFAULT 'PENDING',
  verified_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  uploaded_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_documents_storage_key_unique UNIQUE (storage_key)
);

CREATE INDEX employee_documents_employee_id_idx ON employee_documents (employee_id, category);
CREATE INDEX employee_documents_organization_id_idx ON employee_documents (organization_id);
CREATE INDEX employee_documents_verification_idx ON employee_documents (organization_id, verification_status);

CREATE TRIGGER employee_documents_set_updated_at BEFORE UPDATE ON employee_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- PAN (plan section 13)
-- ---------------------------------------------------------------------------
CREATE TABLE employee_pan_details (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  pan_number           TEXT NOT NULL,
  pan_name             TEXT NOT NULL,
  document_id          UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  verification_status  verification_status NOT NULL DEFAULT 'PENDING',
  verified_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_pan_details_employee_unique UNIQUE (employee_id),
  CONSTRAINT employee_pan_format CHECK (pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);

CREATE INDEX employee_pan_details_organization_id_idx ON employee_pan_details (organization_id);
CREATE TRIGGER employee_pan_details_set_updated_at BEFORE UPDATE ON employee_pan_details
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Aadhaar (plan section 14)
--
-- `aadhaar_last4` is stored alongside the full number so lists and search can
-- work without ever reading the sensitive column.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_aadhaar_details (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  aadhaar_number       TEXT NOT NULL,
  aadhaar_last4        TEXT NOT NULL,
  aadhaar_name         TEXT NOT NULL,
  document_id          UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  verification_status  verification_status NOT NULL DEFAULT 'PENDING',
  verified_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_aadhaar_details_employee_unique UNIQUE (employee_id),
  CONSTRAINT employee_aadhaar_format CHECK (aadhaar_number ~ '^[0-9]{12}$'),
  CONSTRAINT employee_aadhaar_last4_format CHECK (aadhaar_last4 ~ '^[0-9]{4}$')
);

CREATE INDEX employee_aadhaar_details_organization_id_idx ON employee_aadhaar_details (organization_id);
CREATE TRIGGER employee_aadhaar_details_set_updated_at BEFORE UPDATE ON employee_aadhaar_details
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Bank accounts (plan section 15)
-- ---------------------------------------------------------------------------
CREATE TABLE employee_bank_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  account_holder_name  TEXT NOT NULL,
  bank_name            TEXT NOT NULL,
  account_number       TEXT NOT NULL,
  account_last4        TEXT NOT NULL,
  ifsc_code            TEXT NOT NULL,
  branch_name          TEXT,
  account_type         bank_account_type NOT NULL DEFAULT 'SAVINGS',
  is_primary           BOOLEAN NOT NULL DEFAULT TRUE,
  document_id          UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  verification_status  verification_status NOT NULL DEFAULT 'PENDING',
  verified_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_bank_ifsc_format CHECK (ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  CONSTRAINT employee_bank_last4_format CHECK (account_last4 ~ '^[0-9A-Za-z]{1,4}$')
);

CREATE INDEX employee_bank_accounts_employee_id_idx ON employee_bank_accounts (employee_id);
CREATE INDEX employee_bank_accounts_organization_id_idx ON employee_bank_accounts (organization_id);
-- At most one primary account per employee.
CREATE UNIQUE INDEX employee_bank_accounts_primary_unique ON employee_bank_accounts (employee_id) WHERE is_primary;

CREATE TRIGGER employee_bank_accounts_set_updated_at BEFORE UPDATE ON employee_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- PF (plan section 16). Contribution rates default to the organization's
-- configured statutory rules; per-employee overrides stay NULL unless set.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_pf_details (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id                    UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  pf_applicable                  BOOLEAN NOT NULL DEFAULT TRUE,
  uan_number                     TEXT,
  pf_member_id                   TEXT,
  employee_contribution_percent  NUMERIC(6, 3) CHECK (employee_contribution_percent IS NULL OR employee_contribution_percent >= 0),
  employer_contribution_percent  NUMERIC(6, 3) CHECK (employer_contribution_percent IS NULL OR employer_contribution_percent >= 0),
  document_id                    UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  verification_status            verification_status NOT NULL DEFAULT 'PENDING',
  verified_by                    UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at                    TIMESTAMPTZ,
  rejection_reason               TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_pf_details_employee_unique UNIQUE (employee_id),
  CONSTRAINT employee_pf_uan_format CHECK (uan_number IS NULL OR uan_number ~ '^[0-9]{12}$')
);

CREATE INDEX employee_pf_details_organization_id_idx ON employee_pf_details (organization_id);
CREATE TRIGGER employee_pf_details_set_updated_at BEFORE UPDATE ON employee_pf_details
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ESI (plan section 17)
-- ---------------------------------------------------------------------------
CREATE TABLE employee_esi_details (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id                    UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  esi_applicable                 BOOLEAN NOT NULL DEFAULT FALSE,
  esi_number                     TEXT,
  employee_contribution_percent  NUMERIC(6, 3) CHECK (employee_contribution_percent IS NULL OR employee_contribution_percent >= 0),
  employer_contribution_percent  NUMERIC(6, 3) CHECK (employer_contribution_percent IS NULL OR employer_contribution_percent >= 0),
  document_id                    UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  verification_status            verification_status NOT NULL DEFAULT 'PENDING',
  verified_by                    UUID REFERENCES users (id) ON DELETE SET NULL,
  verified_at                    TIMESTAMPTZ,
  rejection_reason               TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_esi_details_employee_unique UNIQUE (employee_id),
  CONSTRAINT employee_esi_number_format CHECK (esi_number IS NULL OR esi_number ~ '^[0-9]{10,17}$')
);

CREATE INDEX employee_esi_details_organization_id_idx ON employee_esi_details (organization_id);
CREATE TRIGGER employee_esi_details_set_updated_at BEFORE UPDATE ON employee_esi_details
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS employee_esi_details;
DROP TABLE IF EXISTS employee_pf_details;
DROP TABLE IF EXISTS employee_bank_accounts;
DROP TABLE IF EXISTS employee_aadhaar_details;
DROP TABLE IF EXISTS employee_pan_details;
DROP TABLE IF EXISTS employee_documents;
DROP TYPE IF EXISTS document_category;
DROP TYPE IF EXISTS bank_account_type;
