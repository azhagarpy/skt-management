-- +migrate Up
-- Labour Welfare Fund: a small statutory contribution collected once a year -
-- a fixed amount from the employee (deducted through payroll, like P.Tax) plus
-- a matching amount from the employer (tracked here only; never deducted from
-- anyone's pay) - then remitted to the government as one lump sum, which an
-- admin records here with a reference document once it is paid.

CREATE TYPE lwf_status AS ENUM ('PENDING', 'PAID');

CREATE TABLE lwf_contributions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- The year this contribution is for.
  contribution_year SMALLINT NOT NULL CHECK (contribution_year BETWEEN 1970 AND 2200),
  employee_amount   NUMERIC(14, 2) NOT NULL DEFAULT 20 CHECK (employee_amount >= 0),
  employer_amount   NUMERIC(14, 2) NOT NULL DEFAULT 40 CHECK (employer_amount >= 0),
  -- The payroll month the employee_amount is actually deducted in.
  payroll_year      SMALLINT NOT NULL CHECK (payroll_year BETWEEN 1970 AND 2200),
  payroll_month     SMALLINT NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  status            lwf_status NOT NULL DEFAULT 'PENDING',
  paid_on           DATE,
  reference_number  TEXT,
  proof_path        TEXT,
  proof_mime_type   TEXT,
  proof_filename    TEXT,
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  paid_by           UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lwf_contributions_employee_year_unique UNIQUE (employee_id, contribution_year),
  CONSTRAINT lwf_contributions_paid_fields CHECK (
    (status = 'PENDING' AND paid_on IS NULL) OR (status = 'PAID' AND paid_on IS NOT NULL)
  )
);

CREATE INDEX lwf_contributions_org_year_idx ON lwf_contributions (organization_id, contribution_year);
CREATE INDEX lwf_contributions_payroll_period_idx ON lwf_contributions (organization_id, payroll_year, payroll_month);

CREATE TRIGGER lwf_contributions_set_updated_at BEFORE UPDATE ON lwf_contributions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS lwf_contributions;
DROP TYPE IF EXISTS lwf_status;
