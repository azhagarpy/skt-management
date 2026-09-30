-- +migrate Up
-- Bonuses and PL Wages are paid separately from salary, and overtime is added
-- straight to net pay.
--
-- A bonus or a PL Wages credit is no longer an earning on the payslip. Each is
-- paid on its own and marked paid in its own module - the date, how it was
-- paid, a reference and an optional supporting document - or back to not paid.
-- Overtime moves out of gross earnings and is added to net pay after the
-- deductions, like Other Credits, so payroll keeps its own total of it.

-- ---------------------------------------------------------------------------
-- How a bonus or a PL Wages credit was paid. One supporting document may back
-- many rows paid together, so the same proof_path can appear on several rows.
-- ---------------------------------------------------------------------------
ALTER TABLE employee_bonuses
  ADD COLUMN paid_on          DATE,
  ADD COLUMN payment_method   payment_method,
  ADD COLUMN reference_number TEXT,
  ADD COLUMN payment_notes    TEXT,
  ADD COLUMN paid_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN proof_path       TEXT,
  ADD COLUMN proof_filename   TEXT,
  ADD COLUMN proof_mime_type  TEXT
    CONSTRAINT employee_bonuses_proof_mime_type
    CHECK (proof_mime_type IN ('application/pdf', 'image/png', 'image/jpeg'));

-- pl_wages_credits already has paid_on.
ALTER TABLE pl_wages_credits
  ADD COLUMN payment_method   payment_method,
  ADD COLUMN reference_number TEXT,
  ADD COLUMN payment_notes    TEXT,
  ADD COLUMN paid_by          UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN proof_path       TEXT,
  ADD COLUMN proof_filename   TEXT,
  ADD COLUMN proof_mime_type  TEXT
    CONSTRAINT pl_wages_credits_proof_mime_type
    CHECK (proof_mime_type IN ('application/pdf', 'image/png', 'image/jpeg'));

-- ---------------------------------------------------------------------------
-- Overtime added to net pay, outside gross. Items calculated before this keep
-- their overtime inside gross earnings, so their total stays 0.
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_items
  ADD COLUMN total_overtime NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs
  ADD COLUMN total_overtime NUMERIC(14, 2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- A bonus or credit that an approved or locked run already paid as an earning
-- went out with that month's salary: record it as paid, so it is never paid a
-- second time.
-- ---------------------------------------------------------------------------
UPDATE employee_bonuses b
   SET status = 'PAID',
       paid_on = paid.paid_on,
       payment_notes = 'Paid with the salary for ' || paid.label
  FROM (
    SELECT DISTINCT ON (c.reference_id)
           c.reference_id,
           coalesce(r.approved_at, r.locked_at, now())::date AS paid_on,
           to_char(make_date(r.year, r.month, 1), 'FMMonth YYYY') AS label
      FROM payroll_item_components c
      JOIN payroll_items i ON i.id = c.payroll_item_id
      JOIN payroll_runs r ON r.id = i.payroll_run_id
     WHERE c.source = 'BONUS'
       AND c.reference_id IS NOT NULL
       AND r.status IN ('APPROVED', 'LOCKED')
     ORDER BY c.reference_id, r.year, r.month
  ) paid
 WHERE paid.reference_id = b.id
   AND b.status IN ('APPROVED', 'PAID');

UPDATE pl_wages_credits p
   SET status = 'PAID',
       paid_on = coalesce(p.paid_on, paid.paid_on),
       payment_notes = 'Paid with the salary for ' || paid.label
  FROM (
    SELECT DISTINCT ON (c.reference_id)
           c.reference_id,
           coalesce(r.approved_at, r.locked_at, now())::date AS paid_on,
           to_char(make_date(r.year, r.month, 1), 'FMMonth YYYY') AS label
      FROM payroll_item_components c
      JOIN payroll_items i ON i.id = c.payroll_item_id
      JOIN payroll_runs r ON r.id = i.payroll_run_id
     WHERE c.component_code = 'PL_WAGES'
       AND c.reference_id IS NOT NULL
       AND r.status IN ('APPROVED', 'LOCKED')
     ORDER BY c.reference_id, r.year, r.month
  ) paid
 WHERE paid.reference_id = p.id
   AND p.status IN ('APPROVED', 'PAID');

-- ---------------------------------------------------------------------------
-- An open run calculated under the old rules still pays bonuses and PL Wages,
-- and counts overtime in gross. Send it back to DRAFT so it is recalculated
-- before anyone can approve it.
-- ---------------------------------------------------------------------------
UPDATE payroll_runs r
   SET status = 'DRAFT'
 WHERE r.status IN ('CALCULATED', 'UNDER_REVIEW')
   AND EXISTS (
     SELECT 1
       FROM payroll_item_components c
       JOIN payroll_items i ON i.id = c.payroll_item_id
      WHERE i.payroll_run_id = r.id
        AND (c.source IN ('BONUS', 'OVERTIME') OR c.component_code = 'PL_WAGES')
   );

-- +migrate Down
-- The rows marked paid and the runs sent back to DRAFT are not recorded, so
-- those data changes are not reversed.
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS total_overtime;
ALTER TABLE payroll_items DROP COLUMN IF EXISTS total_overtime;

ALTER TABLE pl_wages_credits
  DROP CONSTRAINT IF EXISTS pl_wages_credits_proof_mime_type,
  DROP COLUMN IF EXISTS proof_mime_type,
  DROP COLUMN IF EXISTS proof_filename,
  DROP COLUMN IF EXISTS proof_path,
  DROP COLUMN IF EXISTS paid_by,
  DROP COLUMN IF EXISTS payment_notes,
  DROP COLUMN IF EXISTS reference_number,
  DROP COLUMN IF EXISTS payment_method;

ALTER TABLE employee_bonuses
  DROP CONSTRAINT IF EXISTS employee_bonuses_proof_mime_type,
  DROP COLUMN IF EXISTS proof_mime_type,
  DROP COLUMN IF EXISTS proof_filename,
  DROP COLUMN IF EXISTS proof_path,
  DROP COLUMN IF EXISTS paid_by,
  DROP COLUMN IF EXISTS payment_notes,
  DROP COLUMN IF EXISTS reference_number,
  DROP COLUMN IF EXISTS payment_method,
  DROP COLUMN IF EXISTS paid_on;
