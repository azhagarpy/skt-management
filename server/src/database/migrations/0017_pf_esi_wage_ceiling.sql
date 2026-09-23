-- +migrate Up
-- Replaces the per-component PF/ESI flags with a per-structure wage ceiling,
-- and splits the employer's PF contribution into its statutory EPS and EPF
-- shares:
--   - A component no longer says whether it counts toward the PF/ESI wage;
--     the whole structure's gross now does, capped by these new columns.
--   - PF is deducted, on both sides, on the wage up to `pf_wage_ceiling`
--     (statutory default Rs 15,000) instead of the uncapped wage.
--   - Of the employer's total PF rate, `pf_eps_rate` (statutory default
--     8.33%) goes to the Pension Scheme (EPS); the remainder goes to EPF.
--     Both are rounded to the nearest rupee, same as EPFO returns.
--   - ESI keeps its existing all-or-nothing eligibility rule, but the
--     Rs 21,000 limit is now `esi_wage_limit`, configurable per structure
--     instead of a hard-coded constant.
-- The wage and ceiling actually used for each run are frozen onto the payroll
-- item so statutory reports do not have to re-derive them from a structure
-- that may since have changed.
-- There is no live data to migrate: this is a pre-launch schema.

ALTER TABLE salary_components
  DROP COLUMN pf_applicable,
  DROP COLUMN esi_applicable;

ALTER TABLE salary_structures
  ADD COLUMN pf_wage_ceiling NUMERIC(12, 2) NOT NULL DEFAULT 15000 CHECK (pf_wage_ceiling >= 0),
  ADD COLUMN pf_eps_rate     NUMERIC(6, 3)  NOT NULL DEFAULT 8.33  CHECK (pf_eps_rate >= 0 AND pf_eps_rate <= 100),
  ADD COLUMN esi_wage_limit  NUMERIC(12, 2) NOT NULL DEFAULT 21000 CHECK (esi_wage_limit >= 0);

ALTER TABLE payroll_items
  ADD COLUMN pf_wage         NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (pf_wage >= 0),
  ADD COLUMN pf_wage_ceiling NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (pf_wage_ceiling >= 0),
  ADD COLUMN esi_wage        NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (esi_wage >= 0);

ALTER TABLE employee_pf_details
  ADD COLUMN pf_name             TEXT,
  ADD COLUMN pension_applicable  BOOLEAN NOT NULL DEFAULT TRUE;

-- +migrate Down
ALTER TABLE employee_pf_details
  DROP COLUMN pension_applicable,
  DROP COLUMN pf_name;

ALTER TABLE payroll_items
  DROP COLUMN esi_wage,
  DROP COLUMN pf_wage_ceiling,
  DROP COLUMN pf_wage;

ALTER TABLE salary_structures
  DROP COLUMN esi_wage_limit,
  DROP COLUMN pf_eps_rate,
  DROP COLUMN pf_wage_ceiling;

ALTER TABLE salary_components
  ADD COLUMN pf_applicable  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN esi_applicable BOOLEAN NOT NULL DEFAULT FALSE;
