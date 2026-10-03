-- +migrate Up
-- PF and ESI remittances.
--
-- Each payroll run's PF and ESI - the employees' shares deducted from pay plus
-- the employer's on top - are paid to EPFO and ESIC as one challan per scheme.
-- A row here records that a run's challan for one scheme was paid, with the
-- proof of payment; a run with no row for a scheme is still unpaid. What is due
-- is always read from the run's own components, never stored.

CREATE TABLE payroll_statutory_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_run_id    UUID NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  scheme            TEXT NOT NULL CHECK (scheme IN ('PF', 'ESI')),
  -- What was actually paid, which can differ from what the run says is due
  -- (PF admin charges, interest or damages paid with the challan).
  amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_on           DATE NOT NULL,
  -- The challan / TRRN number.
  reference_number  TEXT,
  notes             TEXT,
  -- A payment is never recorded without its proof. The file lives in object
  -- storage like every other upload; only its key and type are kept here.
  proof_path        TEXT NOT NULL,
  proof_filename    TEXT NOT NULL,
  proof_mime_type   TEXT NOT NULL
    CONSTRAINT payroll_statutory_payments_proof_mime_type
    CHECK (proof_mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  paid_by           UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_statutory_payments_run_scheme_unique UNIQUE (payroll_run_id, scheme)
);

CREATE INDEX payroll_statutory_payments_organization_idx ON payroll_statutory_payments (organization_id);
CREATE TRIGGER payroll_statutory_payments_set_updated_at BEFORE UPDATE ON payroll_statutory_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS payroll_statutory_payments;
