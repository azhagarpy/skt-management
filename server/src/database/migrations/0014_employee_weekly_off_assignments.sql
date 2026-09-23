-- +migrate Up
-- Per-employee weekly off, assigned from a calendar (README wishlist item 1):
-- an admin or supervisor picks a date/weekday and assigns specific employees a
-- weekly off, which then keeps applying to future weeks until reconfigured. This
-- sits on top of the existing department/location weekly_off_rules as a more
-- specific override, rather than replacing them.

-- The recurring assignment: employee + weekday, open-ended until superseded.
CREATE TABLE employee_weekly_off_assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  weekday           weekday_name NOT NULL,
  effective_from    DATE NOT NULL,
  effective_to      DATE,
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_weekly_off_assignments_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One open (or date-overlapping) recurring assignment per employee at a time,
-- same shape as employee_salary_assignments' exclusion constraint.
ALTER TABLE employee_weekly_off_assignments
  ADD CONSTRAINT employee_weekly_off_assignments_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'), '[]') WITH &&
  );

CREATE INDEX employee_weekly_off_assignments_employee_id_idx ON employee_weekly_off_assignments (employee_id);
CREATE INDEX employee_weekly_off_assignments_org_idx ON employee_weekly_off_assignments (organization_id);

-- The one-off, specific-date grant: a manual single-week override, or (from
-- 0015_overtime.sql onward) an overtime-earned extra day off.
CREATE TABLE employee_extra_weekly_offs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  off_date           DATE NOT NULL,
  source             TEXT NOT NULL DEFAULT 'ADMIN_ASSIGNED',
  granted_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_extra_weekly_offs_unique UNIQUE (employee_id, off_date),
  CONSTRAINT employee_extra_weekly_offs_source_check
    CHECK (source IN ('ADMIN_ASSIGNED', 'OVERTIME_CONVERSION'))
);

CREATE INDEX employee_extra_weekly_offs_employee_id_idx ON employee_extra_weekly_offs (employee_id);

-- +migrate Down
DROP TABLE IF EXISTS employee_extra_weekly_offs;
DROP TABLE IF EXISTS employee_weekly_off_assignments;
