-- +migrate Up
-- P.Tax deducted from a leaver's final salary.
--
-- P.Tax is worked out on a half-year's wages and deducted after the half-year
-- ends, by which time someone who left during it is no longer paid. When an
-- employee is marked as having left, the administrator can deduct the
-- half-year's tax from their final salary instead. That is a tax_deductions row
-- with on_exit set, in the payroll month that holds the exit date.
--
-- Its amount depends on that month's wages, so payroll works it out when it
-- calculates the month (the half-year's wages so far, that month's included)
-- and writes the figure back here. Until then the row holds an estimate from
-- the months already calculated.

ALTER TABLE tax_deductions ADD COLUMN on_exit BOOLEAN NOT NULL DEFAULT FALSE;

-- Worked out from wages, the tax on exit can come to nothing.
ALTER TABLE tax_deductions DROP CONSTRAINT tax_deductions_tax_amount_check;
ALTER TABLE tax_deductions ADD CONSTRAINT tax_deductions_tax_amount_check CHECK (tax_amount >= 0);

-- A leaver's final month can carry both: the tax for the half-year that just
-- ended, set from the tax report, and the tax on exit for the one now running.
ALTER TABLE tax_deductions DROP CONSTRAINT tax_deductions_employee_month_unique;
ALTER TABLE tax_deductions ADD CONSTRAINT tax_deductions_employee_month_unique
  UNIQUE (employee_id, payroll_year, payroll_month, on_exit);

-- +migrate Down
DELETE FROM tax_deductions WHERE on_exit OR tax_amount = 0;

ALTER TABLE tax_deductions DROP CONSTRAINT tax_deductions_employee_month_unique;
ALTER TABLE tax_deductions ADD CONSTRAINT tax_deductions_employee_month_unique
  UNIQUE (employee_id, payroll_year, payroll_month);

ALTER TABLE tax_deductions DROP CONSTRAINT tax_deductions_tax_amount_check;
ALTER TABLE tax_deductions ADD CONSTRAINT tax_deductions_tax_amount_check CHECK (tax_amount > 0);

ALTER TABLE tax_deductions DROP COLUMN on_exit;
