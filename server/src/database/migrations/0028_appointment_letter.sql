-- +migrate Up
-- Fields the statutory Letter of Appointment prints but the records did not
-- carry: the employee's parent name, the skill category the work is classified
-- under, and the broad nature of the duties. The establishment's Labour
-- Identification Number joins the organization's other registration
-- identifiers (0009_org_branding.sql, drawn by utils/pdf.ts).

CREATE TYPE skill_category AS ENUM ('UNSKILLED', 'SEMI_SKILLED', 'SKILLED', 'HIGHLY_SKILLED');

ALTER TABLE employees
  ADD COLUMN parent_name    TEXT,
  ADD COLUMN skill_category skill_category,
  ADD COLUMN duties         TEXT;

ALTER TABLE organizations
  ADD COLUMN labour_identification_number TEXT;

-- +migrate Down
ALTER TABLE organizations
  DROP COLUMN IF EXISTS labour_identification_number;

ALTER TABLE employees
  DROP COLUMN IF EXISTS duties,
  DROP COLUMN IF EXISTS skill_category,
  DROP COLUMN IF EXISTS parent_name;

DROP TYPE IF EXISTS skill_category;
