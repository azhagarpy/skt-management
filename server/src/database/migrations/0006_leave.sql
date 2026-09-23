-- +migrate Up
-- Leave types, policies, balances, requests and approvals (plan section 10).

CREATE TYPE leave_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE leave_day_portion AS ENUM ('FULL_DAY', 'HALF_DAY');
CREATE TYPE leave_accrual_period AS ENUM ('ANNUAL', 'MONTHLY', 'QUARTERLY', 'NONE');
CREATE TYPE leave_approval_action AS ENUM ('APPROVED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- Leave types
--
-- `is_paid` drives payroll: nothing assumes a particular leave type is paid
-- (plan section 22 - "Do not hard-code assumptions about whether every leave
-- type is paid").
-- ---------------------------------------------------------------------------
CREATE TABLE leave_types (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  code               TEXT NOT NULL,
  description        TEXT,
  annual_limit       NUMERIC(6, 2) CHECK (annual_limit IS NULL OR annual_limit >= 0),
  is_paid            BOOLEAN NOT NULL DEFAULT TRUE,
  requires_approval  BOOLEAN NOT NULL DEFAULT TRUE,
  allow_half_day     BOOLEAN NOT NULL DEFAULT TRUE,
  -- When true, weekly offs and holidays inside the range are not counted as leave.
  exclude_weekly_off BOOLEAN NOT NULL DEFAULT TRUE,
  exclude_holidays   BOOLEAN NOT NULL DEFAULT TRUE,
  max_consecutive_days INTEGER CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  requires_attachment BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_types_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX leave_types_organization_id_idx ON leave_types (organization_id, is_active);
CREATE TRIGGER leave_types_set_updated_at BEFORE UPDATE ON leave_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Leave policies: how a leave type accrues for a group of employees.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_policies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  leave_type_id         UUID NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  employment_type       employment_type,
  department_id         UUID REFERENCES departments (id) ON DELETE CASCADE,
  accrual_period        leave_accrual_period NOT NULL DEFAULT 'ANNUAL',
  accrual_amount        NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (accrual_amount >= 0),
  opening_balance       NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  carry_forward_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  max_carry_forward     NUMERIC(6, 2) CHECK (max_carry_forward IS NULL OR max_carry_forward >= 0),
  allow_negative_balance BOOLEAN NOT NULL DEFAULT FALSE,
  min_service_days      INTEGER NOT NULL DEFAULT 0 CHECK (min_service_days >= 0),
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_policies_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX leave_policies_organization_id_idx ON leave_policies (organization_id, is_active);
CREATE INDEX leave_policies_leave_type_idx ON leave_policies (leave_type_id);
CREATE TRIGGER leave_policies_set_updated_at BEFORE UPDATE ON leave_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Balances, tracked per leave year.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_leave_balances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id    UUID NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
  leave_year       SMALLINT NOT NULL CHECK (leave_year BETWEEN 1970 AND 2200),
  opening_balance  NUMERIC(6, 2) NOT NULL DEFAULT 0,
  accrued          NUMERIC(6, 2) NOT NULL DEFAULT 0,
  carried_forward  NUMERIC(6, 2) NOT NULL DEFAULT 0,
  used             NUMERIC(6, 2) NOT NULL DEFAULT 0,
  -- Consumed by PENDING requests so an employee cannot double-book a balance.
  pending          NUMERIC(6, 2) NOT NULL DEFAULT 0,
  adjustment       NUMERIC(6, 2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_leave_balances_unique UNIQUE (employee_id, leave_type_id, leave_year)
);

CREATE INDEX employee_leave_balances_employee_idx ON employee_leave_balances (employee_id, leave_year);
CREATE INDEX employee_leave_balances_organization_idx ON employee_leave_balances (organization_id, leave_year);
CREATE TRIGGER employee_leave_balances_set_updated_at BEFORE UPDATE ON employee_leave_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Leave requests
-- ---------------------------------------------------------------------------
CREATE TABLE leave_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id     UUID NOT NULL REFERENCES leave_types (id) ON DELETE RESTRICT,
  from_date         DATE NOT NULL,
  to_date           DATE NOT NULL,
  day_portion       leave_day_portion NOT NULL DEFAULT 'FULL_DAY',
  -- Working days actually consumed after excluding weekly offs/holidays.
  total_days        NUMERIC(6, 2) NOT NULL CHECK (total_days > 0),
  reason            TEXT NOT NULL,
  status            leave_request_status NOT NULL DEFAULT 'PENDING',
  attachment_id     UUID REFERENCES employee_documents (id) ON DELETE SET NULL,
  applied_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  decided_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  decision_comment  TEXT,
  cancelled_at      TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_date_range CHECK (to_date >= from_date),
  CONSTRAINT leave_requests_half_day_single_date
    CHECK (day_portion = 'FULL_DAY' OR from_date = to_date)
);

CREATE INDEX leave_requests_employee_idx ON leave_requests (employee_id, from_date DESC);
CREATE INDEX leave_requests_organization_status_idx ON leave_requests (organization_id, status);
CREATE INDEX leave_requests_range_idx ON leave_requests (organization_id, from_date, to_date);
CREATE INDEX leave_requests_leave_type_idx ON leave_requests (leave_type_id);

CREATE TRIGGER leave_requests_set_updated_at BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Overlapping *active* leave for the same employee is rejected at the database
-- level; cancelled and rejected requests are free to overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  ) WHERE (status IN ('PENDING', 'APPROVED'));

-- ---------------------------------------------------------------------------
-- Approval trail: kept separate from the request so a multi-step workflow can be
-- introduced later without changing existing rows.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_approvals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  leave_request_id  UUID NOT NULL REFERENCES leave_requests (id) ON DELETE CASCADE,
  approver_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
  approver_employee_id UUID REFERENCES employees (id) ON DELETE SET NULL,
  step              SMALLINT NOT NULL DEFAULT 1,
  action            leave_approval_action NOT NULL,
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX leave_approvals_request_idx ON leave_approvals (leave_request_id, step);

-- Now that leave_requests exists, wire up the attendance foreign keys that were
-- left dangling in migration 0005.
ALTER TABLE attendance
  ADD CONSTRAINT attendance_leave_request_fk
    FOREIGN KEY (leave_request_id) REFERENCES leave_requests (id) ON DELETE SET NULL,
  ADD CONSTRAINT attendance_leave_type_fk
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE SET NULL;

-- +migrate Down
ALTER TABLE attendance
  DROP CONSTRAINT IF EXISTS attendance_leave_type_fk,
  DROP CONSTRAINT IF EXISTS attendance_leave_request_fk;
DROP TABLE IF EXISTS leave_approvals;
DROP TABLE IF EXISTS leave_requests;
DROP TABLE IF EXISTS employee_leave_balances;
DROP TABLE IF EXISTS leave_policies;
DROP TABLE IF EXISTS leave_types;
DROP TYPE IF EXISTS leave_approval_action;
DROP TYPE IF EXISTS leave_accrual_period;
DROP TYPE IF EXISTS leave_day_portion;
DROP TYPE IF EXISTS leave_request_status;
