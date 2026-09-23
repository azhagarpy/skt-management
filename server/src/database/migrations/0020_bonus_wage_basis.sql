-- +migrate Up
-- A bonus can now be worked out as a percentage of the wages an employee earned
-- over a range of payroll months. The amount is still stored as a plain fixed
-- amount (that is what payroll pays); these columns keep how it was arrived at,
-- so a bonus can always be explained later.

ALTER TABLE employee_bonuses
  ADD COLUMN wage_percentage  NUMERIC(6, 3) CHECK (wage_percentage IS NULL OR wage_percentage > 0),
  ADD COLUMN wage_base        NUMERIC(14, 2) CHECK (wage_base IS NULL OR wage_base >= 0),
  ADD COLUMN man_days         NUMERIC(8, 2) CHECK (man_days IS NULL OR man_days >= 0),
  ADD COLUMN wage_period_from DATE,
  ADD COLUMN wage_period_to   DATE,
  ADD CONSTRAINT employee_bonuses_wage_period_order
    CHECK (wage_period_from IS NULL OR wage_period_to IS NULL OR wage_period_to >= wage_period_from);

-- +migrate Down
ALTER TABLE employee_bonuses
  DROP CONSTRAINT IF EXISTS employee_bonuses_wage_period_order,
  DROP COLUMN IF EXISTS wage_period_to,
  DROP COLUMN IF EXISTS wage_period_from,
  DROP COLUMN IF EXISTS man_days,
  DROP COLUMN IF EXISTS wage_base,
  DROP COLUMN IF EXISTS wage_percentage;
