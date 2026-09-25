-- +migrate Up
-- Makes the supply type a list an administrator can manage, like departments
-- and designations, instead of a hard-coded enum.
--
-- The catch is that employee_type was never just a label: overtime branches on
-- it. SUPPLY converts every 8 overtime hours into an extra weekly off; PSR is
-- paid per hour in payroll. A free-form list would let someone add a third type
-- that matches neither branch, and those employees' overtime would silently
-- vanish - no error, just people not paid and not given their days off.
--
-- So a type carries its behaviour explicitly. Adding a type means choosing how
-- its overtime is handled, and the code branches on that choice rather than on
-- the name, which leaves no way to create a type the rules do not cover.

CREATE TYPE overtime_handling AS ENUM ('OFF_IN_LIEU', 'PAID_HOURLY');

CREATE TABLE employee_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  code              TEXT NOT NULL,
  description       TEXT,
  -- OFF_IN_LIEU: overtime becomes extra weekly offs, never money.
  -- PAID_HOURLY:  overtime is paid at the employee's per-hour rate.
  overtime_handling overtime_handling NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  display_order     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_types_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX employee_types_organization_id_idx ON employee_types (organization_id, is_active);
CREATE TRIGGER employee_types_set_updated_at BEFORE UPDATE ON employee_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The two existing values, for every organization, with the behaviour they
-- already had in code.
INSERT INTO employee_types (organization_id, name, code, description, overtime_handling, display_order)
SELECT o.id, v.name, v.code, v.description, v.handling::overtime_handling, v.ord
  FROM organizations o
 CROSS JOIN (VALUES
   ('Supply', 'SUPPLY', 'Overtime converts to extra weekly offs, 8 hours per off.', 'OFF_IN_LIEU', 10),
   ('PSR',    'PSR',    'Overtime is paid at the employee''s hourly rate.',         'PAID_HOURLY', 20)
 ) AS v(name, code, description, handling, ord);

ALTER TABLE employees
  ADD COLUMN employee_type_id UUID REFERENCES employee_types (id) ON DELETE RESTRICT;

UPDATE employees e
   SET employee_type_id = t.id
  FROM employee_types t
 WHERE t.organization_id = e.organization_id
   AND t.code = e.employee_type::text;

-- employee_type was NOT NULL with a default, so every row just matched.
ALTER TABLE employees ALTER COLUMN employee_type_id SET NOT NULL;
CREATE INDEX employees_employee_type_id_idx ON employees (organization_id, employee_type_id);

-- Job history records the type an employee was on at the time, so it moves to
-- the new table as well - otherwise DROP TYPE below fails on the dependency,
-- and the history would still be describing types by a name nothing else uses.
ALTER TABLE employee_job_history
  ADD COLUMN employee_type_id UUID REFERENCES employee_types (id) ON DELETE SET NULL;

UPDATE employee_job_history h
   SET employee_type_id = t.id
  FROM employee_types t
 WHERE t.organization_id = h.organization_id
   AND t.code = h.employee_type::text
   AND h.employee_type IS NOT NULL;

ALTER TABLE employee_job_history DROP COLUMN employee_type;

ALTER TABLE employees DROP COLUMN employee_type;
DROP TYPE employee_type;

-- +migrate Down
CREATE TYPE employee_type AS ENUM ('SUPPLY', 'PSR');
ALTER TABLE employees ADD COLUMN employee_type employee_type NOT NULL DEFAULT 'SUPPLY';
ALTER TABLE employee_job_history ADD COLUMN employee_type employee_type;

UPDATE employee_job_history h
   SET employee_type = CASE WHEN t.code = 'PSR' THEN 'PSR'::employee_type ELSE 'SUPPLY'::employee_type END
  FROM employee_types t
 WHERE t.id = h.employee_type_id;

ALTER TABLE employee_job_history DROP COLUMN employee_type_id;

-- Only the two original codes map back; anything added since becomes SUPPLY,
-- which is the column's own default and the safer of the two (no money moves).
UPDATE employees e
   SET employee_type = CASE WHEN t.code = 'PSR' THEN 'PSR'::employee_type ELSE 'SUPPLY'::employee_type END
  FROM employee_types t
 WHERE t.id = e.employee_type_id;

CREATE INDEX employees_employee_type_idx ON employees (organization_id, employee_type);

ALTER TABLE employees DROP COLUMN employee_type_id;
DROP TABLE employee_types;
DROP TYPE overtime_handling;
