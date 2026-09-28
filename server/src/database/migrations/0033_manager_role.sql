-- +migrate Up
-- Managers: a level above supervisors. A manager oversees a set of supervisors
-- (each supervisor's `manager_id` points at them) and, through them, every
-- employee those supervisors look after. Like supervisors, managers are
-- employees, flagged with `is_manager`, and sign in with the MANAGER role.

-- PostgreSQL 12+ allows this inside a transaction as long as the new value is
-- not used in the same one, which this migration does not.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'SUPERVISOR';

ALTER TABLE employees
  ADD COLUMN is_manager BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN manager_id UUID REFERENCES employees (id) ON DELETE SET NULL,
  ADD CONSTRAINT employees_not_own_manager CHECK (manager_id IS NULL OR manager_id <> id);

CREATE INDEX employees_manager_id_idx ON employees (manager_id);

-- +migrate Down
-- An enum value cannot be dropped in place; MANAGER stays in user_role but no
-- account is left holding it.
UPDATE users SET role = 'SUPERVISOR' WHERE role = 'MANAGER';
DROP INDEX IF EXISTS employees_manager_id_idx;
ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_not_own_manager,
  DROP COLUMN IF EXISTS manager_id,
  DROP COLUMN IF EXISTS is_manager;
