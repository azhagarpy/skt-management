-- +migrate Up
-- Status-based attendance (plan sections 4-7).
--
-- Deliberately no check-in/check-out, break, GPS, biometric, working-hours or
-- overtime columns: those are out of scope for this stage. The table is shaped so
-- they can be added later as nullable columns without touching existing rows.

CREATE TYPE attendance_status AS ENUM (
  'PRESENT', 'ABSENT', 'ON_LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF'
);

CREATE TYPE attendance_source AS ENUM ('MANUAL', 'BULK', 'LEAVE_APPROVAL', 'HOLIDAY_RULE', 'WEEKLY_OFF_RULE', 'IMPORT');

CREATE TABLE attendance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  attendance_date  DATE NOT NULL,
  status           attendance_status NOT NULL,
  leave_request_id UUID,
  leave_type_id    UUID,
  holiday_id       UUID REFERENCES holidays (id) ON DELETE SET NULL,
  source           attendance_source NOT NULL DEFAULT 'MANUAL',
  remarks          TEXT,
  -- Set once the date has been consumed by an approved/locked payroll run, after
  -- which edits are refused (plan section 33).
  locked_by_payroll_run_id UUID,
  marked_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Plan section 5: one attendance record per employee per date.
  CONSTRAINT attendance_employee_date_unique UNIQUE (employee_id, attendance_date)
);

CREATE INDEX attendance_organization_date_idx ON attendance (organization_id, attendance_date);
CREATE INDEX attendance_employee_date_idx ON attendance (employee_id, attendance_date DESC);
CREATE INDEX attendance_status_idx ON attendance (organization_id, attendance_date, status);
CREATE INDEX attendance_leave_request_idx ON attendance (leave_request_id);

CREATE TRIGGER attendance_set_updated_at BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only history of every attendance correction (plan section 60).
CREATE TABLE attendance_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id    UUID NOT NULL REFERENCES attendance (id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  attendance_date  DATE NOT NULL,
  previous_status  attendance_status,
  new_status       attendance_status NOT NULL,
  reason           TEXT,
  changed_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attendance_history_attendance_id_idx ON attendance_history (attendance_id, created_at DESC);
CREATE INDEX attendance_history_employee_idx ON attendance_history (employee_id, attendance_date);

-- +migrate Down
DROP TABLE IF EXISTS attendance_history;
DROP TABLE IF EXISTS attendance;
DROP TYPE IF EXISTS attendance_source;
DROP TYPE IF EXISTS attendance_status;
