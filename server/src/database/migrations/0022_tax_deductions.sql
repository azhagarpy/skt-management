-- +migrate Up
-- Tax deducted from salary.
--
-- The tax report works out each employee's tax on their wages over a period. An
-- administrator then chooses the payroll month it comes out of pay; one row here
-- is that decision for one employee. Payroll reads the rows for the month it is
-- calculating and deducts the amount as a "P.Tax" line. The amount and what it
-- was worked out on are kept as they were at the time, so a payslip can always be
-- explained even after the slabs change.

CREATE TABLE tax_deductions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- The payroll month the tax is deducted in.
  payroll_year     SMALLINT NOT NULL CHECK (payroll_year BETWEEN 1970 AND 2200),
  payroll_month    SMALLINT NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  -- The wages the tax was worked out on.
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  wage_base        NUMERIC(14, 2) NOT NULL CHECK (wage_base >= 0),
  tax_amount       NUMERIC(14, 2) NOT NULL CHECK (tax_amount > 0),
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_deductions_period_order CHECK (period_to >= period_from),
  -- One tax deduction per employee per payroll month.
  CONSTRAINT tax_deductions_employee_month_unique UNIQUE (employee_id, payroll_year, payroll_month)
);

CREATE INDEX tax_deductions_period_idx ON tax_deductions (organization_id, payroll_year, payroll_month);
CREATE TRIGGER tax_deductions_set_updated_at BEFORE UPDATE ON tax_deductions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS tax_deductions;
