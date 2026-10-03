-- +migrate Up
-- Many PF and ESI challans per payroll run.
--
-- A run's PF or ESI is often paid in more than one challan - separate
-- challans for arrears, damages or another establishment code - so the one
-- payment row per run and scheme of 0042 becomes any number of challans,
-- each with its own number, date, amount and proof of payment. Whether a
-- scheme is paid is worked out from them: their total against what the run
-- owes.

CREATE TABLE payroll_statutory_challans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_run_id    UUID NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  scheme            TEXT NOT NULL CHECK (scheme IN ('PF', 'ESI')),
  amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_on           DATE NOT NULL,
  -- The challan / TRRN number. Required for new challans; a payment carried
  -- over from 0042 may not have one.
  challan_number    TEXT,
  notes             TEXT,
  -- A challan is never recorded without its proof. The file lives in object
  -- storage like every other upload; only its key and type are kept here.
  proof_path        TEXT NOT NULL,
  proof_filename    TEXT NOT NULL,
  proof_mime_type   TEXT NOT NULL
    CONSTRAINT payroll_statutory_challans_proof_mime_type
    CHECK (proof_mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  uploaded_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payroll_statutory_challans_run_idx ON payroll_statutory_challans (payroll_run_id, scheme, paid_on);
CREATE INDEX payroll_statutory_challans_organization_idx ON payroll_statutory_challans (organization_id);
-- The same challan uploaded twice for one run and scheme is a mistake.
CREATE UNIQUE INDEX payroll_statutory_challans_number_unique
  ON payroll_statutory_challans (payroll_run_id, scheme, lower(challan_number))
  WHERE challan_number IS NOT NULL;
CREATE TRIGGER payroll_statutory_challans_set_updated_at BEFORE UPDATE ON payroll_statutory_challans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Payments already recorded become their scheme's first challan.
INSERT INTO payroll_statutory_challans
  (organization_id, payroll_run_id, scheme, amount, paid_on, challan_number, notes,
   proof_path, proof_filename, proof_mime_type, uploaded_by, created_at, updated_at)
SELECT organization_id, payroll_run_id, scheme, amount, paid_on, reference_number, notes,
       proof_path, proof_filename, proof_mime_type, paid_by, created_at, updated_at
  FROM payroll_statutory_payments;

DROP TABLE payroll_statutory_payments;

-- +migrate Down
-- Back to one payment per run and scheme: the challans' total, dated and
-- referenced as the latest of them, with its proof. The other challans'
-- proof files stay in storage, unreferenced.
CREATE TABLE payroll_statutory_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_run_id    UUID NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  scheme            TEXT NOT NULL CHECK (scheme IN ('PF', 'ESI')),
  amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_on           DATE NOT NULL,
  reference_number  TEXT,
  notes             TEXT,
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

INSERT INTO payroll_statutory_payments
  (organization_id, payroll_run_id, scheme, amount, paid_on, reference_number, notes,
   proof_path, proof_filename, proof_mime_type, paid_by)
SELECT DISTINCT ON (payroll_run_id, scheme)
       organization_id, payroll_run_id, scheme,
       sum(amount) OVER (PARTITION BY payroll_run_id, scheme),
       paid_on, challan_number, notes, proof_path, proof_filename, proof_mime_type, uploaded_by
  FROM payroll_statutory_challans
 ORDER BY payroll_run_id, scheme, paid_on DESC, created_at DESC;

DROP TABLE IF EXISTS payroll_statutory_challans;
