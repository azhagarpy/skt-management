-- +migrate Up
-- Employee type (Supply / PSR) and Plant (Ultratech / ICL). employee_type drives
-- overtime behaviour (0014_overtime.sql); plant is a simple classification.

CREATE TYPE employee_type AS ENUM ('SUPPLY', 'PSR');
CREATE TYPE plant_type AS ENUM ('ULTRATECH', 'ICL');

ALTER TABLE employees
  ADD COLUMN employee_type employee_type NOT NULL DEFAULT 'SUPPLY',
  ADD COLUMN plant plant_type;

CREATE INDEX employees_employee_type_idx ON employees (organization_id, employee_type);

ALTER TYPE job_change_type ADD VALUE IF NOT EXISTS 'EMPLOYEE_TYPE_CHANGE';
ALTER TYPE job_change_type ADD VALUE IF NOT EXISTS 'PLANT_CHANGE';

ALTER TABLE employee_job_history
  ADD COLUMN employee_type employee_type,
  ADD COLUMN plant plant_type;

-- +migrate Down
ALTER TABLE employee_job_history DROP COLUMN IF EXISTS plant;
ALTER TABLE employee_job_history DROP COLUMN IF EXISTS employee_type;
ALTER TABLE employees DROP COLUMN IF EXISTS plant;
ALTER TABLE employees DROP COLUMN IF EXISTS employee_type;
DROP TYPE IF EXISTS plant_type;
DROP TYPE IF EXISTS employee_type;
