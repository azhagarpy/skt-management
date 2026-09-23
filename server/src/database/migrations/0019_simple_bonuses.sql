-- +migrate Up
-- Simplifies bonuses: a bonus is just a name and an amount given to one or many
-- employees, so it no longer points at a bonus type. Existing rows keep the name
-- of the type they used. The bonus_types table is left in place (nothing reads
-- it any more) so this migration stays a pure additive change.

ALTER TABLE employee_bonuses
  ADD COLUMN bonus_name TEXT;

UPDATE employee_bonuses b
   SET bonus_name = t.name
  FROM bonus_types t
 WHERE t.id = b.bonus_type_id;

UPDATE employee_bonuses SET bonus_name = 'Bonus' WHERE bonus_name IS NULL;

ALTER TABLE employee_bonuses
  ALTER COLUMN bonus_name SET NOT NULL,
  ALTER COLUMN bonus_type_id DROP NOT NULL;

-- +migrate Down
-- Rows created without a type cannot be restored to NOT NULL; give them one first.
INSERT INTO bonus_types (organization_id, name, code)
SELECT DISTINCT b.organization_id, 'General bonus', 'GENERAL_BONUS'
  FROM employee_bonuses b
 WHERE b.bonus_type_id IS NULL
ON CONFLICT (organization_id, code) DO NOTHING;

UPDATE employee_bonuses b
   SET bonus_type_id = t.id
  FROM bonus_types t
 WHERE b.bonus_type_id IS NULL
   AND t.organization_id = b.organization_id
   AND t.code = 'GENERAL_BONUS';

ALTER TABLE employee_bonuses
  ALTER COLUMN bonus_type_id SET NOT NULL,
  DROP COLUMN bonus_name;
