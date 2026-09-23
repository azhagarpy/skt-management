-- +migrate Up
-- Overtime (README wishlist item 4): Supply employees convert every 8 OT hours
-- in a week into one extra weekly off (capped at 2/week, from 16 hours); PSR
-- employees are paid for OT hours instead, at a configurable per-hour rate.

CREATE TABLE overtime_entries (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id               UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  work_date                 DATE NOT NULL,
  hours                     NUMERIC(4, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  remarks                   TEXT,
  -- Set once the date has been consumed by an approved/locked payroll run, same
  -- pattern as attendance.locked_by_payroll_run_id.
  locked_by_payroll_run_id  UUID,
  marked_by                 UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT overtime_entries_unique UNIQUE (employee_id, work_date)
);

CREATE INDEX overtime_entries_employee_id_idx ON overtime_entries (employee_id, work_date);
CREATE INDEX overtime_entries_organization_id_idx ON overtime_entries (organization_id);
CREATE TRIGGER overtime_entries_set_updated_at BEFORE UPDATE ON overtime_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trace an extra weekly off back to the overtime that earned it, so revoking or
-- editing the entry can reconcile the grants it produced.
ALTER TABLE employee_extra_weekly_offs
  ADD COLUMN overtime_entry_id UUID REFERENCES overtime_entries (id) ON DELETE SET NULL;

-- PSR per-hour OT rate: an org default, with an optional per-employee override -
-- the same override pattern employee_salary_assignments.override_amount uses.
ALTER TABLE payroll_policies
  ADD COLUMN psr_overtime_rate_minor INTEGER CHECK (psr_overtime_rate_minor IS NULL OR psr_overtime_rate_minor >= 0);
ALTER TABLE employees
  ADD COLUMN overtime_rate_override_minor INTEGER CHECK (overtime_rate_override_minor IS NULL OR overtime_rate_override_minor >= 0);

-- +migrate Down
ALTER TABLE employees DROP COLUMN IF EXISTS overtime_rate_override_minor;
ALTER TABLE payroll_policies DROP COLUMN IF EXISTS psr_overtime_rate_minor;
ALTER TABLE employee_extra_weekly_offs DROP COLUMN IF EXISTS overtime_entry_id;
DROP TABLE IF EXISTS overtime_entries;
