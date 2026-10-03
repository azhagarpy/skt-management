-- +migrate Up
-- Paid offs for Supply employees' overtime.
--
-- Every 8 hours of a Supply employee's overtime in a week (up to 2 a week)
-- used to become an extra weekly off, placed on the week's first working days
-- and unpaid like any weekly off. It is now a paid off: a day off that is paid,
-- on a date an administrator, manager or supervisor chooses. Each is an
-- employee_extra_weekly_offs row with source PAID_OFF.
--
-- Rows already converted the old way (OVERTIME_CONVERSION) keep their meaning,
-- an unpaid weekly off, so recalculating a month does not change what it paid.

ALTER TABLE employee_extra_weekly_offs DROP CONSTRAINT employee_extra_weekly_offs_source_check;
ALTER TABLE employee_extra_weekly_offs ADD CONSTRAINT employee_extra_weekly_offs_source_check
  CHECK (source IN ('ADMIN_ASSIGNED', 'OVERTIME_CONVERSION', 'PAID_OFF'));

UPDATE employee_types
   SET description = 'Overtime earns paid offs: a paid day off for every 8 hours, on a date chosen for it.'
 WHERE code = 'SUPPLY' AND description = 'Overtime converts to extra weekly offs, 8 hours per off.';

-- The paid offs payroll counted in a month, beside its weekly offs.
ALTER TABLE payroll_items ADD COLUMN paid_off_days NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (paid_off_days >= 0);

-- +migrate Down
ALTER TABLE payroll_items DROP COLUMN paid_off_days;

UPDATE employee_types
   SET description = 'Overtime converts to extra weekly offs, 8 hours per off.'
 WHERE code = 'SUPPLY' AND description = 'Overtime earns paid offs: a paid day off for every 8 hours, on a date chosen for it.';

DELETE FROM employee_extra_weekly_offs WHERE source = 'PAID_OFF';
ALTER TABLE employee_extra_weekly_offs DROP CONSTRAINT employee_extra_weekly_offs_source_check;
ALTER TABLE employee_extra_weekly_offs ADD CONSTRAINT employee_extra_weekly_offs_source_check
  CHECK (source IN ('ADMIN_ASSIGNED', 'OVERTIME_CONVERSION'));
