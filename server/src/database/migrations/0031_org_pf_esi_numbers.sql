-- +migrate Up
-- The organization carried a generic tax_id and registration_no, neither of
-- which matched what this business actually records. What goes on a payslip,
-- an appointment letter and the statutory returns is the establishment's PF
-- code and its ESI code, so the columns are renamed to say so.
--
-- A rename rather than new columns: whatever was typed into these fields was
-- already the PF and ESI numbers in practice, and dropping them would throw
-- that away.

ALTER TABLE organizations RENAME COLUMN tax_id TO pf_number;
ALTER TABLE organizations RENAME COLUMN registration_no TO esi_number;

-- +migrate Down
ALTER TABLE organizations RENAME COLUMN pf_number TO tax_id;
ALTER TABLE organizations RENAME COLUMN esi_number TO registration_no;
