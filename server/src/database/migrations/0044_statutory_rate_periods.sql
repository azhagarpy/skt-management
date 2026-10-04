-- +migrate Up
-- Date-ranged PF and ESI rates per salary structure.
--
-- PF and ESI rates, the PF wage ceiling, the EPS share and the ESI wage limit
-- change over time - PF deducted at 8% up to a date and at 9.5% from it - so
-- they move off the salary structure into periods of their own:
--   - A period is in force from `effective_from` until the day before the
--     structure's next period starts; the latest runs on with no end.
--   - A structure's first period has no start date (NULL): it covers every
--     date before the first dated change, so a structure always has rates.
--   - Payroll uses the period in force on the run's period end, the same date
--     that picks the employee's salary assignment. Items already calculated
--     keep the rates frozen in their calculation snapshot.
-- Each structure's current settings become its first period.

CREATE TABLE salary_structure_statutory_rates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_structure_id  UUID NOT NULL REFERENCES salary_structures (id) ON DELETE CASCADE,
  effective_from       DATE,
  pf_employee_rate     NUMERIC(6, 3)  NOT NULL CHECK (pf_employee_rate >= 0 AND pf_employee_rate <= 100),
  pf_employer_rate     NUMERIC(6, 3)  NOT NULL CHECK (pf_employer_rate >= 0 AND pf_employer_rate <= 100),
  pf_wage_ceiling      NUMERIC(12, 2) NOT NULL CHECK (pf_wage_ceiling >= 0),
  pf_eps_rate          NUMERIC(6, 3)  NOT NULL CHECK (pf_eps_rate >= 0 AND pf_eps_rate <= 100),
  esi_employee_rate    NUMERIC(6, 3)  NOT NULL CHECK (esi_employee_rate >= 0 AND esi_employee_rate <= 100),
  esi_employer_rate    NUMERIC(6, 3)  NOT NULL CHECK (esi_employer_rate >= 0 AND esi_employer_rate <= 100),
  esi_wage_limit       NUMERIC(12, 2) NOT NULL CHECK (esi_wage_limit >= 0),
  created_by           UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One period per start date, and one undated first period, per structure.
CREATE UNIQUE INDEX salary_structure_statutory_rates_from_unique
  ON salary_structure_statutory_rates (salary_structure_id, effective_from)
  WHERE effective_from IS NOT NULL;
CREATE UNIQUE INDEX salary_structure_statutory_rates_first_unique
  ON salary_structure_statutory_rates (salary_structure_id)
  WHERE effective_from IS NULL;
CREATE TRIGGER salary_structure_statutory_rates_set_updated_at BEFORE UPDATE ON salary_structure_statutory_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO salary_structure_statutory_rates
  (salary_structure_id, effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling, pf_eps_rate,
   esi_employee_rate, esi_employer_rate, esi_wage_limit, created_by)
SELECT id, NULL, pf_employee_rate, pf_employer_rate, pf_wage_ceiling, pf_eps_rate,
       esi_employee_rate, esi_employer_rate, esi_wage_limit, created_by
  FROM salary_structures;

ALTER TABLE salary_structures
  DROP COLUMN pf_employee_rate,
  DROP COLUMN pf_employer_rate,
  DROP COLUMN pf_wage_ceiling,
  DROP COLUMN pf_eps_rate,
  DROP COLUMN esi_employee_rate,
  DROP COLUMN esi_employer_rate,
  DROP COLUMN esi_wage_limit;

-- +migrate Down
-- Back to one set of rates per structure: the period in force today.
ALTER TABLE salary_structures
  ADD COLUMN pf_employee_rate  NUMERIC(6, 3)  NOT NULL DEFAULT 12
    CHECK (pf_employee_rate >= 0 AND pf_employee_rate <= 100),
  ADD COLUMN pf_employer_rate  NUMERIC(6, 3)  NOT NULL DEFAULT 12
    CHECK (pf_employer_rate >= 0 AND pf_employer_rate <= 100),
  ADD COLUMN pf_wage_ceiling   NUMERIC(12, 2) NOT NULL DEFAULT 15000 CHECK (pf_wage_ceiling >= 0),
  ADD COLUMN pf_eps_rate       NUMERIC(6, 3)  NOT NULL DEFAULT 8.33  CHECK (pf_eps_rate >= 0 AND pf_eps_rate <= 100),
  ADD COLUMN esi_employee_rate NUMERIC(6, 3)  NOT NULL DEFAULT 0.75
    CHECK (esi_employee_rate >= 0 AND esi_employee_rate <= 100),
  ADD COLUMN esi_employer_rate NUMERIC(6, 3)  NOT NULL DEFAULT 3.25
    CHECK (esi_employer_rate >= 0 AND esi_employer_rate <= 100),
  ADD COLUMN esi_wage_limit    NUMERIC(12, 2) NOT NULL DEFAULT 21000 CHECK (esi_wage_limit >= 0);

UPDATE salary_structures s
   SET pf_employee_rate  = r.pf_employee_rate,
       pf_employer_rate  = r.pf_employer_rate,
       pf_wage_ceiling   = r.pf_wage_ceiling,
       pf_eps_rate       = r.pf_eps_rate,
       esi_employee_rate = r.esi_employee_rate,
       esi_employer_rate = r.esi_employer_rate,
       esi_wage_limit    = r.esi_wage_limit
  FROM (
    SELECT DISTINCT ON (salary_structure_id) *
      FROM salary_structure_statutory_rates
     WHERE effective_from IS NULL OR effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY salary_structure_id, effective_from DESC NULLS LAST
  ) r
 WHERE r.salary_structure_id = s.id;

DROP TABLE IF EXISTS salary_structure_statutory_rates;
