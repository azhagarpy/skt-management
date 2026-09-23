-- +migrate Up
-- Salary structures, statutory configuration, deductions and bonuses
-- (plan sections 16, 17, 19-26).

CREATE TYPE salary_component_type AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION');
CREATE TYPE calculation_type AS ENUM ('FIXED', 'PERCENTAGE');
CREATE TYPE percentage_base AS ENUM ('BASIC', 'GROSS', 'CTC', 'COMPONENT');
CREATE TYPE assignment_status AS ENUM ('ACTIVE', 'SUPERSEDED', 'CANCELLED');
CREATE TYPE statutory_kind AS ENUM ('PF', 'ESI', 'PROFESSIONAL_TAX', 'TDS');
CREATE TYPE paid_days_basis AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS', 'ACTUAL_ATTENDANCE_DAYS');
CREATE TYPE bonus_amount_type AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE');
CREATE TYPE bonus_status AS ENUM ('PENDING', 'APPROVED', 'PAID', 'CANCELLED');
CREATE TYPE deduction_status AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- Salary component catalogue (plan section 20)
-- ---------------------------------------------------------------------------
CREATE TABLE salary_components (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  component_type   salary_component_type NOT NULL,
  calculation_type calculation_type NOT NULL DEFAULT 'FIXED',
  percentage_base  percentage_base,
  base_component_code TEXT,
  taxable          BOOLEAN NOT NULL DEFAULT TRUE,
  pf_applicable    BOOLEAN NOT NULL DEFAULT FALSE,
  esi_applicable   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fixed allowances that must not shrink with attendance (e.g. a reimbursement)
  -- set prorate = FALSE.
  prorate          BOOLEAN NOT NULL DEFAULT TRUE,
  display_order    INTEGER NOT NULL DEFAULT 0,
  is_statutory     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT salary_components_org_code_unique UNIQUE (organization_id, code),
  CONSTRAINT salary_components_percentage_base_required
    CHECK (calculation_type <> 'PERCENTAGE' OR percentage_base IS NOT NULL)
);

CREATE INDEX salary_components_organization_id_idx ON salary_components (organization_id, is_active);
CREATE TRIGGER salary_components_set_updated_at BEFORE UPDATE ON salary_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Salary structures
--
-- A MONTHLY structure holds per-month amounts; a DAILY structure holds per-day
-- amounts which the calculator multiplies by paid days (plan sections 19 and 22).
-- ---------------------------------------------------------------------------
CREATE TABLE salary_structures (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  description      TEXT,
  salary_basis     salary_basis NOT NULL DEFAULT 'MONTHLY',
  currency_code    TEXT NOT NULL DEFAULT 'INR',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT salary_structures_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX salary_structures_organization_id_idx ON salary_structures (organization_id, is_active);
CREATE TRIGGER salary_structures_set_updated_at BEFORE UPDATE ON salary_structures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE salary_structure_components (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_structure_id  UUID NOT NULL REFERENCES salary_structures (id) ON DELETE CASCADE,
  salary_component_id  UUID NOT NULL REFERENCES salary_components (id) ON DELETE RESTRICT,
  calculation_type     calculation_type NOT NULL DEFAULT 'FIXED',
  amount               NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  percentage           NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (percentage >= 0),
  display_order        INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT salary_structure_components_unique UNIQUE (salary_structure_id, salary_component_id)
);

CREATE INDEX salary_structure_components_structure_idx ON salary_structure_components (salary_structure_id);
CREATE TRIGGER salary_structure_components_set_updated_at BEFORE UPDATE ON salary_structure_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Employee salary assignments (plan section 21)
--
-- Append-only history: raising a salary closes the previous row rather than
-- overwriting it, so historical payroll stays reproducible.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_salary_assignments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  salary_structure_id  UUID NOT NULL REFERENCES salary_structures (id) ON DELETE RESTRICT,
  effective_from       DATE NOT NULL,
  effective_to         DATE,
  status               assignment_status NOT NULL DEFAULT 'ACTIVE',
  -- Optional per-employee override of the structure total: monthly gross for a
  -- MONTHLY structure, or the daily rate for a DAILY structure. Components are
  -- scaled proportionally when set.
  override_amount      NUMERIC(14, 2) CHECK (override_amount IS NULL OR override_amount >= 0),
  notes                TEXT,
  created_by           UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_salary_assignments_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX employee_salary_assignments_employee_idx
  ON employee_salary_assignments (employee_id, effective_from DESC);
CREATE INDEX employee_salary_assignments_organization_idx
  ON employee_salary_assignments (organization_id, status);

-- Two active assignments must never overlap in time for the same employee.
ALTER TABLE employee_salary_assignments
  ADD CONSTRAINT employee_salary_assignments_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'ACTIVE');

CREATE TRIGGER employee_salary_assignments_set_updated_at BEFORE UPDATE ON employee_salary_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Statutory configuration (plan sections 16, 17, 63 rule 15)
--
-- PF/ESI/PT rates are data, never constants in code. `config` holds the rule set
-- for the period, for example:
--   { "employeeRate": 12, "employerRate": 12, "wageCeiling": 15000,
--     "wageBase": "PF_APPLICABLE_COMPONENTS", "applyCeiling": true,
--     "roundTo": 1 }
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Payroll policy (plan sections 23, 24)
--
-- Decides how paid days are derived and how a half day is valued. Nothing about
-- this is assumed in code.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_policies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  paid_days_basis           paid_days_basis NOT NULL DEFAULT 'CALENDAR_DAYS',
  -- Total fraction of a HALF_DAY_LEAVE day treated as paid.
  --   ...paid_fraction   applies when the leave half is a PAID leave type.
  --     1.000 = worked half (0.5) + paid leave half (0.5)
  --   ...unpaid_fraction applies when the leave half is an UNPAID leave type.
  --     0.500 = worked half only
  -- Both are configuration, so an organization that values a half day
  -- differently changes data rather than code (plan section 24).
  half_day_paid_fraction    NUMERIC(4, 3) NOT NULL DEFAULT 1.0
    CHECK (half_day_paid_fraction >= 0 AND half_day_paid_fraction <= 1),
  half_day_unpaid_fraction  NUMERIC(4, 3) NOT NULL DEFAULT 0.5
    CHECK (half_day_unpaid_fraction >= 0 AND half_day_unpaid_fraction <= 1),
  count_holidays_as_paid    BOOLEAN NOT NULL DEFAULT TRUE,
  count_weekly_off_as_paid  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Whether an employee who joins or leaves mid-month is paid only for the days
  -- inside their employment window.
  prorate_on_joining        BOOLEAN NOT NULL DEFAULT TRUE,
  prorate_on_exit           BOOLEAN NOT NULL DEFAULT TRUE,
  -- Round the net salary to this many decimals (0 = whole rupees).
  net_rounding_decimals     SMALLINT NOT NULL DEFAULT 2 CHECK (net_rounding_decimals BETWEEN 0 AND 2),
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

-- ---------------------------------------------------------------------------
-- Deductions (plan section 26)
-- ---------------------------------------------------------------------------
CREATE TABLE deduction_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  code              TEXT NOT NULL,
  description       TEXT,
  calculation_type  calculation_type NOT NULL DEFAULT 'FIXED',
  percentage_base   percentage_base,
  is_statutory      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Loans and advances draw down a balance over several months.
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
  -- NULL for a recurring deduction; set for a one-off tied to a single payroll month.
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

-- ---------------------------------------------------------------------------
-- Bonuses (plan section 25)
-- ---------------------------------------------------------------------------
CREATE TABLE bonus_types (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  description      TEXT,
  taxable          BOOLEAN NOT NULL DEFAULT TRUE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bonus_types_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX bonus_types_organization_idx ON bonus_types (organization_id, is_active);
CREATE TRIGGER bonus_types_set_updated_at BEFORE UPDATE ON bonus_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_bonuses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  bonus_type_id    UUID NOT NULL REFERENCES bonus_types (id) ON DELETE RESTRICT,
  amount_type      bonus_amount_type NOT NULL DEFAULT 'FIXED_AMOUNT',
  amount           NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  percentage       NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (percentage >= 0),
  bonus_date       DATE NOT NULL,
  -- The payroll month the bonus is paid out in.
  payroll_year     SMALLINT NOT NULL CHECK (payroll_year BETWEEN 1970 AND 2200),
  payroll_month    SMALLINT NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  reason           TEXT,
  status           bonus_status NOT NULL DEFAULT 'PENDING',
  approved_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX employee_bonuses_employee_idx ON employee_bonuses (employee_id, payroll_year, payroll_month);
CREATE INDEX employee_bonuses_period_idx ON employee_bonuses (organization_id, payroll_year, payroll_month, status);
CREATE TRIGGER employee_bonuses_set_updated_at BEFORE UPDATE ON employee_bonuses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS employee_bonuses;
DROP TABLE IF EXISTS bonus_types;
DROP TABLE IF EXISTS employee_deductions;
DROP TABLE IF EXISTS deduction_types;
DROP TABLE IF EXISTS payroll_policies;
DROP TABLE IF EXISTS statutory_configs;
DROP TABLE IF EXISTS employee_salary_assignments;
DROP TABLE IF EXISTS salary_structure_components;
DROP TABLE IF EXISTS salary_structures;
DROP TABLE IF EXISTS salary_components;
DROP TYPE IF EXISTS deduction_status;
DROP TYPE IF EXISTS bonus_status;
DROP TYPE IF EXISTS bonus_amount_type;
DROP TYPE IF EXISTS paid_days_basis;
DROP TYPE IF EXISTS statutory_kind;
DROP TYPE IF EXISTS assignment_status;
DROP TYPE IF EXISTS percentage_base;
DROP TYPE IF EXISTS calculation_type;
DROP TYPE IF EXISTS salary_component_type;
