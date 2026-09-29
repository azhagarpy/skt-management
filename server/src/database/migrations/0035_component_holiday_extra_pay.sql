-- +migrate Up
-- Whether a salary component is included in the extra day's pay earned by
-- working a holiday (payroll.calculator: holiday work pay). A component left
-- out is still paid for every paid day as usual - only the extra day skips it.
ALTER TABLE salary_components
  ADD COLUMN holiday_extra_pay BOOLEAN NOT NULL DEFAULT TRUE;

-- SKT pays the Special Allowance for the days in the month only, never as part
-- of holiday work pay.
UPDATE salary_components
   SET holiday_extra_pay = FALSE
 WHERE upper(code) = 'SA'
    OR lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'special allowance';

-- +migrate Down
ALTER TABLE salary_components
  DROP COLUMN IF EXISTS holiday_extra_pay;
