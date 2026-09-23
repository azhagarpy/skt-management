-- +migrate Up
-- Holidays can pay extra to whoever works them: with the option on, an employee
-- marked present on the holiday earns one more day's pay on top of the paid
-- holiday itself (a paid holiday + the day's work).
ALTER TABLE holidays
  ADD COLUMN extra_pay_if_worked BOOLEAN NOT NULL DEFAULT FALSE;

-- The payslip line for that extra day. OVERTIME is added here too: the
-- calculator already labels PSR overtime pay with it, but the enum never had it.
ALTER TYPE payroll_component_source ADD VALUE IF NOT EXISTS 'HOLIDAY_WORK';
ALTER TYPE payroll_component_source ADD VALUE IF NOT EXISTS 'OVERTIME';

-- +migrate Down
-- Enum values cannot be dropped; the two added above are left in place.
ALTER TABLE holidays DROP COLUMN IF EXISTS extra_pay_if_worked;
