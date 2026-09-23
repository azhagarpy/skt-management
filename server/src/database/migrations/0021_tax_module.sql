-- +migrate Up
-- Replaces the deductions module with a tax module.
--
-- Deductions (recurring / one-off / recoverable loans) are removed outright. Tax
-- is a set of wage bands, each with the tax amount for a wage that falls in it;
-- the tax report applies them to an employee's total wages over a period.

DROP TABLE IF EXISTS employee_deductions;
DROP TABLE IF EXISTS deduction_types;
DROP TYPE IF EXISTS deduction_status;

-- The permission rows are re-created from code on startup; the removed ones
-- would otherwise linger in the role and user permission screens.
DELETE FROM permissions WHERE code IN ('deduction.view', 'deduction.manage');

-- ---------------------------------------------------------------------------
-- Tax slabs
--
-- A slab is defined by its upper limit only: a wage belongs to the first slab
-- whose limit it does not exceed, and the one slab with no limit (NULL) takes
-- everything above the last limit. That leaves no gaps or overlaps to police.
-- ---------------------------------------------------------------------------
CREATE TABLE tax_slabs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  up_to            NUMERIC(14, 2) CHECK (up_to IS NULL OR up_to > 0),
  tax_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_slabs_org_limit_unique UNIQUE (organization_id, up_to)
);

-- NULLs are distinct to a UNIQUE constraint, so the open-ended slab is guarded separately.
CREATE UNIQUE INDEX tax_slabs_single_open_ended ON tax_slabs (organization_id) WHERE up_to IS NULL;
CREATE TRIGGER tax_slabs_set_updated_at BEFORE UPDATE ON tax_slabs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every existing organization starts with the standard bands.
INSERT INTO tax_slabs (organization_id, up_to, tax_amount)
SELECT o.id, s.up_to, s.tax_amount
  FROM organizations o
 CROSS JOIN (VALUES
   (21000::numeric, 0::numeric),
   (30000::numeric, 120::numeric),
   (45000::numeric, 300::numeric),
   (60000::numeric, 590::numeric),
   (75000::numeric, 890::numeric),
   (NULL::numeric, 1180::numeric)
 ) AS s(up_to, tax_amount);

-- +migrate Down
DROP TABLE IF EXISTS tax_slabs;

CREATE TYPE deduction_status AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

CREATE TABLE deduction_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  code              TEXT NOT NULL,
  description       TEXT,
  calculation_type  calculation_type NOT NULL DEFAULT 'FIXED',
  percentage_base   percentage_base,
  is_statutory      BOOLEAN NOT NULL DEFAULT FALSE,
  is_recoverable    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deduction_types_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX deduction_types_organization_idx ON deduction_types (organization_id, is_active);
CREATE TRIGGER deduction_types_set_updated_at BEFORE UPDATE ON deduction_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_deductions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  deduction_type_id  UUID NOT NULL REFERENCES deduction_types (id) ON DELETE RESTRICT,
  calculation_type   calculation_type NOT NULL DEFAULT 'FIXED',
  amount             NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  percentage         NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (percentage >= 0),
  payroll_year       SMALLINT CHECK (payroll_year IS NULL OR payroll_year BETWEEN 1970 AND 2200),
  payroll_month      SMALLINT CHECK (payroll_month IS NULL OR payroll_month BETWEEN 1 AND 12),
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  total_amount       NUMERIC(14, 2) CHECK (total_amount IS NULL OR total_amount >= 0),
  recovered_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0),
  reason             TEXT,
  status             deduction_status NOT NULL DEFAULT 'ACTIVE',
  created_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_deductions_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employee_deductions_month_pair
    CHECK ((payroll_year IS NULL) = (payroll_month IS NULL))
);

CREATE INDEX employee_deductions_employee_idx ON employee_deductions (employee_id, status);
CREATE INDEX employee_deductions_period_idx ON employee_deductions (organization_id, payroll_year, payroll_month);
CREATE TRIGGER employee_deductions_set_updated_at BEFORE UPDATE ON employee_deductions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
