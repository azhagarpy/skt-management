-- +migrate Up
-- The per-hour rate a paid-hourly overtime entry is paid at, chosen when the
-- entry is recorded: one day's salary / n hours (DAY_SALARY, n in day_divisor),
-- or a custom amount per hour (CUSTOM, in rate_per_hour_minor). Off-in-lieu
-- (Supply) entries carry the default too, but payroll never reads it for them.
ALTER TABLE overtime_entries
  ADD COLUMN rate_basis TEXT NOT NULL DEFAULT 'DAY_SALARY' CHECK (rate_basis IN ('DAY_SALARY', 'CUSTOM')),
  ADD COLUMN day_divisor NUMERIC(4, 2) DEFAULT 8,
  ADD COLUMN rate_per_hour_minor INTEGER;

-- Entries recorded before this for an employee with their own rate were paid
-- at that rate, so they keep it.
UPDATE overtime_entries o
   SET rate_basis = 'CUSTOM',
       day_divisor = NULL,
       rate_per_hour_minor = e.overtime_rate_override_minor
  FROM employees e
 WHERE e.id = o.employee_id
   AND e.overtime_rate_override_minor IS NOT NULL;

ALTER TABLE overtime_entries
  ADD CONSTRAINT overtime_entries_rate CHECK (
    (rate_basis = 'DAY_SALARY' AND day_divisor > 0 AND day_divisor <= 24 AND rate_per_hour_minor IS NULL)
    OR (rate_basis = 'CUSTOM' AND day_divisor IS NULL AND rate_per_hour_minor >= 0)
  );

-- +migrate Down
ALTER TABLE overtime_entries DROP CONSTRAINT IF EXISTS overtime_entries_rate;
ALTER TABLE overtime_entries DROP COLUMN IF EXISTS rate_per_hour_minor;
ALTER TABLE overtime_entries DROP COLUMN IF EXISTS day_divisor;
ALTER TABLE overtime_entries DROP COLUMN IF EXISTS rate_basis;
