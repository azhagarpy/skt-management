-- +migrate Up
-- Payroll runs, items, component snapshots, payments and adjustments
-- (plan sections 27-34).

CREATE TYPE payroll_run_status AS ENUM ('DRAFT', 'CALCULATED', 'UNDER_REVIEW', 'APPROVED', 'LOCKED');
-- Payment status is deliberately a separate concept from run status (plan section 27).
CREATE TYPE payment_status AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID');
CREATE TYPE payment_method AS ENUM ('BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI', 'OTHER');
CREATE TYPE payroll_component_source AS ENUM (
  'SALARY_STRUCTURE', 'BONUS', 'STATUTORY', 'DEDUCTION', 'ADJUSTMENT', 'MANUAL'
);
CREATE TYPE payroll_adjustment_type AS ENUM ('CORRECTION', 'REVERSAL', 'ARREAR', 'RECOVERY');

-- ---------------------------------------------------------------------------
-- Payroll runs
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  year               SMALLINT NOT NULL CHECK (year BETWEEN 1970 AND 2200),
  month              SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  name               TEXT,
  status             payroll_run_status NOT NULL DEFAULT 'DRAFT',
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  payroll_policy_id  UUID REFERENCES payroll_policies (id) ON DELETE SET NULL,
  total_employees    INTEGER NOT NULL DEFAULT 0 CHECK (total_employees >= 0),
  total_gross        NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_deductions   NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_net          NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_paid         NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_pending      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  notes              TEXT,
  created_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  calculated_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  locked_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_at      TIMESTAMPTZ,
  approved_at        TIMESTAMPTZ,
  locked_at          TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Plan section 36: one payroll run per organization per month.
  CONSTRAINT payroll_runs_org_period_unique UNIQUE (organization_id, year, month),
  CONSTRAINT payroll_runs_period_order CHECK (period_end >= period_start)
);

CREATE INDEX payroll_runs_organization_idx ON payroll_runs (organization_id, year DESC, month DESC);
CREATE INDEX payroll_runs_status_idx ON payroll_runs (organization_id, status);
CREATE TRIGGER payroll_runs_set_updated_at BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Attendance rows reference the run that consumed them.
ALTER TABLE attendance
  ADD CONSTRAINT attendance_locked_by_payroll_run_fk
    FOREIGN KEY (locked_by_payroll_run_id) REFERENCES payroll_runs (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Payroll items
--
-- A frozen snapshot of one employee's month: the attendance breakdown, the money
-- and the payment state. Nothing here is recalculated from current salary data
-- once the run is approved (plan section 32).
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_run_id       UUID NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  employee_id          UUID NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,

  -- Snapshot of who the employee was at the time of the run.
  employee_code        TEXT NOT NULL,
  employee_name        TEXT NOT NULL,
  department_name      TEXT,
  designation_name     TEXT,
  supervisor_name      TEXT,
  salary_basis         salary_basis NOT NULL,
  salary_structure_id  UUID REFERENCES salary_structures (id) ON DELETE SET NULL,
  salary_structure_name TEXT,
  salary_assignment_id UUID REFERENCES employee_salary_assignments (id) ON DELETE SET NULL,

  -- Attendance breakdown (plan section 34).
  calendar_days        NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (calendar_days >= 0),
  working_days         NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (working_days >= 0),
  present_days         NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (present_days >= 0),
  absent_days          NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (absent_days >= 0),
  leave_days           NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (leave_days >= 0),
  paid_leave_days      NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (paid_leave_days >= 0),
  unpaid_leave_days    NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (unpaid_leave_days >= 0),
  half_day_leave_days  NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (half_day_leave_days >= 0),
  holiday_days         NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (holiday_days >= 0),
  weekly_off_days      NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (weekly_off_days >= 0),
  unmarked_days        NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (unmarked_days >= 0),
  paid_days            NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (paid_days >= 0),
  payable_days_basis   NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (payable_days_basis >= 0),

  -- Money.
  gross_earnings       NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (gross_earnings >= 0),
  total_bonus          NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_bonus >= 0),
  total_deductions     NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),
  employer_contributions NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (employer_contributions >= 0),
  net_salary           NUMERIC(14, 2) NOT NULL DEFAULT 0,

  -- Payment state, kept separate from the run's status.
  paid_amount          NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  pending_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payment_status       payment_status NOT NULL DEFAULT 'PENDING',

  remarks              TEXT,
  -- Everything the calculator saw, retained so a run can be explained later.
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Plan section 36: one payroll item per employee per run.
  CONSTRAINT payroll_items_run_employee_unique UNIQUE (payroll_run_id, employee_id),
  -- Plan section 55: payments can never exceed the net salary. GREATEST guards
  -- the case where deductions exceed earnings and the net is negative, which the
  -- calculator flags as a warning rather than refusing outright; there, nothing
  -- is payable at all.
  CONSTRAINT payroll_items_paid_not_over_net CHECK (paid_amount <= GREATEST(net_salary, 0))
);

CREATE INDEX payroll_items_run_idx ON payroll_items (payroll_run_id);
CREATE INDEX payroll_items_employee_idx ON payroll_items (employee_id);
CREATE INDEX payroll_items_payment_status_idx ON payroll_items (organization_id, payment_status);
CREATE INDEX payroll_items_organization_idx ON payroll_items (organization_id);
CREATE TRIGGER payroll_items_set_updated_at BEFORE UPDATE ON payroll_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Component snapshot
--
-- Names and codes are copied, not referenced, so renaming a salary component
-- never rewrites history.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_item_components (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_item_id    UUID NOT NULL REFERENCES payroll_items (id) ON DELETE CASCADE,
  component_code     TEXT NOT NULL,
  component_name     TEXT NOT NULL,
  component_type     salary_component_type NOT NULL,
  calculation_type   calculation_type NOT NULL DEFAULT 'FIXED',
  source             payroll_component_source NOT NULL DEFAULT 'SALARY_STRUCTURE',
  -- The full-month entitlement before attendance proration.
  full_amount        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- What actually landed on the payslip.
  amount             NUMERIC(14, 2) NOT NULL DEFAULT 0,
  percentage         NUMERIC(6, 3),
  taxable            BOOLEAN NOT NULL DEFAULT TRUE,
  display_order      INTEGER NOT NULL DEFAULT 0,
  reference_id       UUID,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_item_components_unique UNIQUE (payroll_item_id, component_code, source, reference_id)
);

CREATE INDEX payroll_item_components_item_idx ON payroll_item_components (payroll_item_id, display_order);
CREATE INDEX payroll_item_components_type_idx ON payroll_item_components (organization_id, component_type);
CREATE INDEX payroll_item_components_code_idx ON payroll_item_components (organization_id, component_code);

-- ---------------------------------------------------------------------------
-- Payment transactions (plan section 30)
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_payment_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_item_id   UUID NOT NULL REFERENCES payroll_items (id) ON DELETE CASCADE,
  payment_date      DATE NOT NULL,
  amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  payment_method    payment_method NOT NULL DEFAULT 'BANK_TRANSFER',
  reference_number  TEXT,
  bank_account_id   UUID REFERENCES employee_bank_accounts (id) ON DELETE SET NULL,
  notes             TEXT,
  reversed_at       TIMESTAMPTZ,
  reversal_reason   TEXT,
  reversed_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payroll_payment_transactions_item_idx ON payroll_payment_transactions (payroll_item_id, payment_date);
CREATE INDEX payroll_payment_transactions_org_idx ON payroll_payment_transactions (organization_id, payment_date);
CREATE UNIQUE INDEX payroll_payment_transactions_reference_unique
  ON payroll_payment_transactions (organization_id, lower(reference_number))
  WHERE reference_number IS NOT NULL AND reversed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Adjustments (plan section 33)
--
-- A locked payroll is never edited in place. Corrections are recorded here and
-- carried into a later run.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id           UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- The run being corrected.
  source_payroll_item_id UUID REFERENCES payroll_items (id) ON DELETE SET NULL,
  adjustment_type       payroll_adjustment_type NOT NULL,
  component_code        TEXT NOT NULL,
  component_name        TEXT NOT NULL,
  component_type        salary_component_type NOT NULL,
  amount                NUMERIC(14, 2) NOT NULL CHECK (amount <> 0),
  -- The run the adjustment is applied in.
  apply_year            SMALLINT NOT NULL CHECK (apply_year BETWEEN 1970 AND 2200),
  apply_month           SMALLINT NOT NULL CHECK (apply_month BETWEEN 1 AND 12),
  applied_payroll_item_id UUID REFERENCES payroll_items (id) ON DELETE SET NULL,
  reason                TEXT NOT NULL,
  applied_at            TIMESTAMPTZ,
  created_by            UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payroll_adjustments_employee_idx ON payroll_adjustments (employee_id, apply_year, apply_month);
CREATE INDEX payroll_adjustments_pending_idx
  ON payroll_adjustments (organization_id, apply_year, apply_month) WHERE applied_at IS NULL;
CREATE TRIGGER payroll_adjustments_set_updated_at BEFORE UPDATE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Payslips: generated once per payroll item and served through a permission
-- checked endpoint, never a public URL.
-- ---------------------------------------------------------------------------
CREATE TABLE payslips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payroll_item_id   UUID NOT NULL REFERENCES payroll_items (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  storage_key       TEXT NOT NULL,
  file_size_bytes   BIGINT NOT NULL CHECK (file_size_bytes > 0),
  checksum_sha256   TEXT,
  generated_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payslips_item_unique UNIQUE (payroll_item_id),
  CONSTRAINT payslips_storage_key_unique UNIQUE (storage_key)
);

CREATE INDEX payslips_employee_idx ON payslips (employee_id, generated_at DESC);

-- +migrate Down
DROP TABLE IF EXISTS payslips;
DROP TABLE IF EXISTS payroll_adjustments;
DROP TABLE IF EXISTS payroll_payment_transactions;
DROP TABLE IF EXISTS payroll_item_components;
DROP TABLE IF EXISTS payroll_items;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_locked_by_payroll_run_fk;
DROP TABLE IF EXISTS payroll_runs;
DROP TYPE IF EXISTS payroll_adjustment_type;
DROP TYPE IF EXISTS payroll_component_source;
DROP TYPE IF EXISTS payment_method;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payroll_run_status;
