-- +migrate Up
-- Simplifies the salary module: PF and ESI rates move onto each salary
-- structure, and the generic statutory-rule engine and configurable payroll
-- policy are removed in favour of one fixed, hard-coded rule:
--   - PF has no wage ceiling; it is deducted on the full PF-applicable wage.
--   - ESI applies, on both sides, only when the structure's ESI-applicable
--     wage is at or below Rs 21,000.
--   - Paid-days basis, half-day fractions, holiday/weekly-off pay and
--     proration are fixed defaults (see payroll.service.ts), not configuration.
--   - The payroll cycle is fixed at the 21st of the previous month through
--     the 20th of the named month for every organization.
-- There is no live data to migrate: this is a pre-launch schema.

ALTER TABLE salary_structures
  ADD COLUMN pf_employee_rate  NUMERIC(6, 3) NOT NULL DEFAULT 12
    CHECK (pf_employee_rate >= 0 AND pf_employee_rate <= 100),
  ADD COLUMN pf_employer_rate  NUMERIC(6, 3) NOT NULL DEFAULT 12
    CHECK (pf_employer_rate >= 0 AND pf_employer_rate <= 100),
  ADD COLUMN esi_employee_rate NUMERIC(6, 3) NOT NULL DEFAULT 0.75
    CHECK (esi_employee_rate >= 0 AND esi_employee_rate <= 100),
  ADD COLUMN esi_employer_rate NUMERIC(6, 3) NOT NULL DEFAULT 3.25
    CHECK (esi_employer_rate >= 0 AND esi_employer_rate <= 100);

ALTER TABLE payroll_runs DROP COLUMN IF EXISTS payroll_policy_id;

DROP TABLE IF EXISTS payroll_policies;
DROP TYPE IF EXISTS paid_days_basis;

DROP TABLE IF EXISTS statutory_configs;
DROP TYPE IF EXISTS statutory_kind;

-- +migrate Down
CREATE TYPE statutory_kind AS ENUM ('PF', 'ESI', 'PROFESSIONAL_TAX', 'TDS');

CREATE TABLE statutory_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind             statutory_kind NOT NULL,
  name             TEXT NOT NULL,
  config           JSONB NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT statutory_configs_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX statutory_configs_lookup_idx ON statutory_configs (organization_id, kind, effective_from DESC);
CREATE TRIGGER statutory_configs_set_updated_at BEFORE UPDATE ON statutory_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE paid_days_basis AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS', 'ACTUAL_ATTENDANCE_DAYS');

CREATE TABLE payroll_policies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  paid_days_basis           paid_days_basis NOT NULL DEFAULT 'CALENDAR_DAYS',
  half_day_paid_fraction    NUMERIC(4, 3) NOT NULL DEFAULT 1.0
    CHECK (half_day_paid_fraction >= 0 AND half_day_paid_fraction <= 1),
  half_day_unpaid_fraction  NUMERIC(4, 3) NOT NULL DEFAULT 0.5
    CHECK (half_day_unpaid_fraction >= 0 AND half_day_unpaid_fraction <= 1),
  count_holidays_as_paid    BOOLEAN NOT NULL DEFAULT TRUE,
  count_weekly_off_as_paid  BOOLEAN NOT NULL DEFAULT TRUE,
  prorate_on_joining        BOOLEAN NOT NULL DEFAULT TRUE,
  prorate_on_exit           BOOLEAN NOT NULL DEFAULT TRUE,
  net_rounding_decimals     SMALLINT NOT NULL DEFAULT 2 CHECK (net_rounding_decimals BETWEEN 0 AND 2),
  cycle_cutoff_day          SMALLINT CHECK (cycle_cutoff_day IS NULL OR cycle_cutoff_day BETWEEN 1 AND 28),
  psr_overtime_rate_minor   INTEGER CHECK (psr_overtime_rate_minor IS NULL OR psr_overtime_rate_minor >= 0),
  effective_from            DATE NOT NULL,
  effective_to              DATE,
  is_default                BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_policies_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX payroll_policies_organization_idx ON payroll_policies (organization_id, is_active);
CREATE UNIQUE INDEX payroll_policies_single_default ON payroll_policies (organization_id) WHERE is_default;
CREATE TRIGGER payroll_policies_set_updated_at BEFORE UPDATE ON payroll_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payroll_runs
  ADD COLUMN payroll_policy_id UUID REFERENCES payroll_policies (id) ON DELETE SET NULL;

ALTER TABLE salary_structures
  DROP COLUMN IF EXISTS pf_employee_rate,
  DROP COLUMN IF EXISTS pf_employer_rate,
  DROP COLUMN IF EXISTS esi_employee_rate,
  DROP COLUMN IF EXISTS esi_employer_rate;
