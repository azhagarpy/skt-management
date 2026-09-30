-- +migrate Up
-- Other Credits: a one-off amount paid to an employee in a chosen payroll
-- month (an incentive, a reimbursement, an advance paid out) and added straight
-- to net pay. It is not an earning: it stays out of gross earnings, so it never
-- reaches the PF, ESI, P.Tax or PL Wages wage, and no deduction is taken from it.
-- Entries are payroll adjustments of this new component type.
ALTER TYPE salary_component_type ADD VALUE IF NOT EXISTS 'CREDIT';

-- Net salary is gross earnings less total deductions plus total credits.
ALTER TABLE payroll_items
  ADD COLUMN total_credits NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs
  ADD COLUMN total_credits NUMERIC(14, 2) NOT NULL DEFAULT 0;

-- +migrate Down
-- Enum values cannot be dropped; CREDIT is left in place.
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS total_credits;
ALTER TABLE payroll_items DROP COLUMN IF EXISTS total_credits;
