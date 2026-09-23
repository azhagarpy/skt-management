-- +migrate Up
-- Optional non-calendar pay cycle: when set, a payroll "month" runs from the day
-- after cycle_cutoff_day in the previous month through cycle_cutoff_day of the
-- named month (e.g. a cutoff of 20 makes "September" mean Aug 21 - Sep 20).
-- NULL keeps the plain calendar month, so this is opt-in per organization.

ALTER TABLE payroll_policies
  ADD COLUMN cycle_cutoff_day SMALLINT
    CHECK (cycle_cutoff_day IS NULL OR cycle_cutoff_day BETWEEN 1 AND 28);

-- +migrate Down
ALTER TABLE payroll_policies DROP COLUMN IF EXISTS cycle_cutoff_day;
