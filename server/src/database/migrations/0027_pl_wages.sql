-- +migrate Up
-- PL Wages: an annual credit for privilege/earned leave wages. An employee who
-- worked at least 20 days in at least 3 separate calendar months of the year
-- earns one day's wage for every 20 days worked across the year, credited into
-- payroll the following January.
--
-- Eligibility and the amount are computed once a year from that year's payroll
-- (see pl-wages.module.ts); an admin then reviews the batch, releases it into a
-- chosen payroll month (which is when payroll actually pays it as an EARNING -
-- see payroll.calculator.ts), and marks it paid once that run is settled.

CREATE TYPE pl_wages_status AS ENUM ('NOT_ELIGIBLE', 'PENDING', 'APPROVED', 'PAID');

CREATE TABLE pl_wages_credits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- The Jan-Dec year being assessed.
  credit_year       SMALLINT NOT NULL CHECK (credit_year BETWEEN 1970 AND 2200),
  qualifying_months SMALLINT NOT NULL DEFAULT 0 CHECK (qualifying_months >= 0 AND qualifying_months <= 12),
  total_days_worked NUMERIC(7, 2) NOT NULL DEFAULT 0 CHECK (total_days_worked >= 0),
  eligible_days     SMALLINT NOT NULL DEFAULT 0 CHECK (eligible_days >= 0),
  daily_wage_rate   NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (daily_wage_rate >= 0),
  credit_amount     NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  status            pl_wages_status NOT NULL DEFAULT 'PENDING',
  -- The payroll month this is actually credited in - set once approved.
  payroll_year      SMALLINT,
  payroll_month     SMALLINT CHECK (payroll_month BETWEEN 1 AND 12),
  paid_on           DATE,
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pl_wages_credits_employee_year_unique UNIQUE (employee_id, credit_year)
);

CREATE INDEX pl_wages_credits_org_year_idx ON pl_wages_credits (organization_id, credit_year);
CREATE INDEX pl_wages_credits_payroll_period_idx ON pl_wages_credits (organization_id, payroll_year, payroll_month);

CREATE TRIGGER pl_wages_credits_set_updated_at BEFORE UPDATE ON pl_wages_credits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS pl_wages_credits;
DROP TYPE IF EXISTS pl_wages_status;
