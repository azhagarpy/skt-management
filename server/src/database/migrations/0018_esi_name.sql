-- +migrate Up
-- "Name as per ESI" can differ in spelling from the employee's own name,
-- same reason employee_pf_details has pf_name (migration 0017). Needed for
-- the ESIC monthly contribution upload format, which lists the IP by this name.
ALTER TABLE employee_esi_details
  ADD COLUMN esi_name TEXT;

-- +migrate Down
ALTER TABLE employee_esi_details
  DROP COLUMN esi_name;
