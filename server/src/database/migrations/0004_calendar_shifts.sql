-- +migrate Up
-- Weekly offs, holidays and shifts (plan sections 8, 9 and 35).

CREATE TYPE weekday_name AS ENUM (
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'
);

-- ---------------------------------------------------------------------------
-- Weekly off rules
--
-- Saturday/Sunday are never hard-coded. A rule is scoped to the organization and
-- may be narrowed to a department or location; the most specific active rule for
-- a date wins (higher `priority` first).
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_off_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  department_id    UUID REFERENCES departments (id) ON DELETE CASCADE,
  location_id      UUID REFERENCES locations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  priority         INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT weekly_off_rules_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX weekly_off_rules_organization_id_idx ON weekly_off_rules (organization_id, is_active);
CREATE INDEX weekly_off_rules_scope_idx ON weekly_off_rules (department_id, location_id);
CREATE TRIGGER weekly_off_rules_set_updated_at BEFORE UPDATE ON weekly_off_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per weekday covered by the rule.
--   occurrences = NULL  -> every occurrence of that weekday ("every Sunday")
--   occurrences = {2,4} -> 2nd and 4th occurrence ("2nd and 4th Saturday")
--   include_last = TRUE -> also the final occurrence in the month
CREATE TABLE weekly_off_rule_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       UUID NOT NULL REFERENCES weekly_off_rules (id) ON DELETE CASCADE,
  weekday       weekday_name NOT NULL,
  occurrences   SMALLINT[],
  include_last  BOOLEAN NOT NULL DEFAULT FALSE,
  is_half_day   BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT weekly_off_rule_days_unique UNIQUE (rule_id, weekday),
  CONSTRAINT weekly_off_rule_days_occurrences_valid
    CHECK (occurrences IS NULL OR (array_length(occurrences, 1) BETWEEN 1 AND 5))
);

CREATE INDEX weekly_off_rule_days_rule_id_idx ON weekly_off_rule_days (rule_id);

-- ---------------------------------------------------------------------------
-- Holiday calendars and holidays (plan section 9)
-- ---------------------------------------------------------------------------
CREATE TABLE holiday_calendars (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  year             SMALLINT NOT NULL CHECK (year BETWEEN 1970 AND 2200),
  location_id      UUID REFERENCES locations (id) ON DELETE SET NULL,
  is_default       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT holiday_calendars_unique UNIQUE (organization_id, name, year)
);

CREATE INDEX holiday_calendars_organization_id_idx ON holiday_calendars (organization_id, year);
CREATE TRIGGER holiday_calendars_set_updated_at BEFORE UPDATE ON holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE holidays (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  calendar_id      UUID REFERENCES holiday_calendars (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  holiday_date     DATE NOT NULL,
  description      TEXT,
  is_optional      BOOLEAN NOT NULL DEFAULT FALSE,
  is_paid          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT holidays_unique_per_calendar UNIQUE (calendar_id, holiday_date, name)
);

CREATE INDEX holidays_organization_date_idx ON holidays (organization_id, holiday_date);
CREATE INDEX holidays_calendar_id_idx ON holidays (calendar_id);
CREATE TRIGGER holidays_set_updated_at BEFORE UPDATE ON holidays
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Shifts
--
-- Attendance is status-based today (plan section 4). Shift times are recorded so
-- check-in/check-out can be layered on later without a schema rewrite.
-- ---------------------------------------------------------------------------
CREATE TABLE shifts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  start_time       TIME,
  end_time         TIME,
  break_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  is_night_shift   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shifts_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX shifts_organization_id_idx ON shifts (organization_id);
CREATE TRIGGER shifts_set_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_shift_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  shift_id        UUID NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_shift_assignments_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX employee_shift_assignments_employee_idx ON employee_shift_assignments (employee_id, effective_from DESC);
CREATE TRIGGER employee_shift_assignments_set_updated_at BEFORE UPDATE ON employee_shift_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS employee_shift_assignments;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS holiday_calendars;
DROP TABLE IF EXISTS weekly_off_rule_days;
DROP TABLE IF EXISTS weekly_off_rules;
DROP TYPE IF EXISTS weekday_name;
