-- +migrate Up
-- Sandwich rule: a holiday with leave on the day before and the day after is
-- charged as leave itself, even though `exclude_holidays` leaves a holiday at
-- the edge of a request free. The leave on either side may belong to a
-- different request, so the check reads the attendance already written rather
-- than only the dates of the request being counted (leave.service.ts).

ALTER TABLE leave_types
  ADD COLUMN sandwich_holidays BOOLEAN NOT NULL DEFAULT TRUE;

-- +migrate Down
ALTER TABLE leave_types
  DROP COLUMN IF EXISTS sandwich_holidays;
