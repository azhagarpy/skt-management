-- +migrate Up
-- Departments, designations, locations, employees and employment history.

CREATE TYPE employment_status AS ENUM ('ACTIVE', 'INACTIVE', 'ON_NOTICE', 'RESIGNED', 'TERMINATED');
CREATE TYPE employment_type AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN');
CREATE TYPE gender_type AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');
CREATE TYPE marital_status AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED');
CREATE TYPE salary_basis AS ENUM ('MONTHLY', 'DAILY');

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  address_line1    TEXT,
  address_line2    TEXT,
  city             TEXT,
  state            TEXT,
  country          TEXT NOT NULL DEFAULT 'India',
  pincode          TEXT,
  timezone         TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT locations_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX locations_organization_id_idx ON locations (organization_id);
CREATE TRIGGER locations_set_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  parent_department_id UUID REFERENCES departments (id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  code                 TEXT NOT NULL,
  description          TEXT,
  head_employee_id     UUID,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT departments_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX departments_organization_id_idx ON departments (organization_id);
CREATE TRIGGER departments_set_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Designations
-- ---------------------------------------------------------------------------
CREATE TABLE designations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  department_id    UUID REFERENCES departments (id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL,
  description      TEXT,
  level            INTEGER,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT designations_org_code_unique UNIQUE (organization_id, code)
);

CREATE INDEX designations_organization_id_idx ON designations (organization_id);
CREATE TRIGGER designations_set_updated_at BEFORE UPDATE ON designations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Employees
--
-- Supervisors are employees too (plan section 18 requires them to carry the same
-- identity/financial documents), so a single table backs both, linked to a user
-- account whose role decides what the person may do.
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id               UUID REFERENCES users (id) ON DELETE SET NULL,
  employee_code         TEXT NOT NULL,

  first_name            TEXT NOT NULL,
  middle_name           TEXT,
  last_name             TEXT,
  gender                gender_type NOT NULL DEFAULT 'UNDISCLOSED',
  date_of_birth         DATE,
  marital_status        marital_status NOT NULL DEFAULT 'UNDISCLOSED',
  blood_group           TEXT,
  personal_email        TEXT,
  work_email            TEXT,
  mobile_number         TEXT,
  alternate_number      TEXT,
  photo_path            TEXT,

  department_id         UUID REFERENCES departments (id) ON DELETE SET NULL,
  designation_id        UUID REFERENCES designations (id) ON DELETE SET NULL,
  location_id           UUID REFERENCES locations (id) ON DELETE SET NULL,
  supervisor_id         UUID REFERENCES employees (id) ON DELETE SET NULL,

  is_supervisor         BOOLEAN NOT NULL DEFAULT FALSE,
  employment_type       employment_type NOT NULL DEFAULT 'FULL_TIME',
  employment_status     employment_status NOT NULL DEFAULT 'ACTIVE',
  salary_basis          salary_basis NOT NULL DEFAULT 'MONTHLY',

  joining_date          DATE NOT NULL,
  confirmation_date     DATE,
  notice_start_date     DATE,
  exit_date             DATE,
  exit_reason           TEXT,

  created_by            UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_by            UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT employees_org_code_unique UNIQUE (organization_id, employee_code),
  CONSTRAINT employees_exit_after_joining CHECK (exit_date IS NULL OR exit_date >= joining_date),
  CONSTRAINT employees_not_own_supervisor CHECK (supervisor_id IS NULL OR supervisor_id <> id)
);

CREATE INDEX employees_organization_id_idx ON employees (organization_id);
CREATE INDEX employees_department_id_idx ON employees (department_id);
CREATE INDEX employees_designation_id_idx ON employees (designation_id);
CREATE INDEX employees_supervisor_id_idx ON employees (supervisor_id);
CREATE INDEX employees_status_idx ON employees (organization_id, employment_status);
CREATE INDEX employees_user_id_idx ON employees (user_id);
CREATE INDEX employees_name_trgm_idx ON employees USING gin ((first_name || ' ' || coalesce(last_name, '')) gin_trgm_ops);

CREATE TRIGGER employees_set_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE departments
  ADD CONSTRAINT departments_head_employee_fk FOREIGN KEY (head_employee_id) REFERENCES employees (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Addresses and emergency contacts
-- ---------------------------------------------------------------------------
CREATE TYPE address_type AS ENUM ('CURRENT', 'PERMANENT');

CREATE TABLE employee_addresses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  address_type   address_type NOT NULL DEFAULT 'CURRENT',
  address_line1  TEXT NOT NULL,
  address_line2  TEXT,
  city           TEXT NOT NULL,
  state          TEXT NOT NULL,
  country        TEXT NOT NULL DEFAULT 'India',
  pincode        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_addresses_unique UNIQUE (employee_id, address_type)
);

CREATE INDEX employee_addresses_employee_id_idx ON employee_addresses (employee_id);
CREATE TRIGGER employee_addresses_set_updated_at BEFORE UPDATE ON employee_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_emergency_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  relationship  TEXT NOT NULL,
  phone         TEXT NOT NULL,
  alternate_phone TEXT,
  address       TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX employee_emergency_contacts_employee_id_idx ON employee_emergency_contacts (employee_id);
CREATE TRIGGER employee_emergency_contacts_set_updated_at BEFORE UPDATE ON employee_emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Job history: an append-only record of every employment change (plan section 60).
-- ---------------------------------------------------------------------------
CREATE TYPE job_change_type AS ENUM (
  'JOINED', 'PROMOTION', 'TRANSFER', 'DEPARTMENT_CHANGE', 'DESIGNATION_CHANGE',
  'SUPERVISOR_CHANGE', 'LOCATION_CHANGE', 'STATUS_CHANGE', 'EMPLOYMENT_TYPE_CHANGE', 'EXIT'
);

CREATE TABLE employee_job_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  change_type       job_change_type NOT NULL,
  effective_from    DATE NOT NULL,
  department_id     UUID REFERENCES departments (id) ON DELETE SET NULL,
  designation_id    UUID REFERENCES designations (id) ON DELETE SET NULL,
  location_id       UUID REFERENCES locations (id) ON DELETE SET NULL,
  supervisor_id     UUID REFERENCES employees (id) ON DELETE SET NULL,
  employment_type   employment_type,
  employment_status employment_status,
  notes             TEXT,
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX employee_job_history_employee_id_idx ON employee_job_history (employee_id, effective_from DESC);
CREATE INDEX employee_job_history_organization_id_idx ON employee_job_history (organization_id);

-- +migrate Down
DROP TABLE IF EXISTS employee_job_history;
DROP TYPE IF EXISTS job_change_type;
DROP TABLE IF EXISTS employee_emergency_contacts;
DROP TABLE IF EXISTS employee_addresses;
DROP TYPE IF EXISTS address_type;
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_head_employee_fk;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS designations;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS locations;
DROP TYPE IF EXISTS salary_basis;
DROP TYPE IF EXISTS marital_status;
DROP TYPE IF EXISTS gender_type;
DROP TYPE IF EXISTS employment_type;
DROP TYPE IF EXISTS employment_status;
