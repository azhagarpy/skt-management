-- +migrate Up
-- A new notification event: an employee absent for a run of consecutive days.
-- Raised by the attendance module so an administrator or supervisor hears about
-- someone who has stopped turning up without applying for leave, rather than
-- discovering it when payroll is calculated.
--
-- ALTER TYPE ... ADD VALUE runs inside this migration's transaction, which
-- PostgreSQL allows as long as the new value is not used before it commits -
-- nothing here inserts a row with it.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'ABSENCE_STREAK';

-- +migrate Down
-- PostgreSQL cannot remove a value from an enum. Rows keeping the value would
-- break a rebuild of the type, so the down migration deletes them and leaves
-- the (harmless, unused) label in place.
DELETE FROM notifications WHERE type = 'ABSENCE_STREAK';
