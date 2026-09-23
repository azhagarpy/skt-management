-- +migrate Up
-- Records which shift an attendance day was worked under (README wishlist item 2:
-- a shift select box - A/B/C/G - on attendance rows). The `shifts` table and its
-- full CRUD API already existed; attendance itself had no shift column yet.

ALTER TABLE attendance ADD COLUMN shift_id UUID REFERENCES shifts (id) ON DELETE SET NULL;
CREATE INDEX attendance_shift_id_idx ON attendance (shift_id);

-- Seed the four standard shift codes for every existing organization so the
-- selector has something to show immediately, without requiring an admin to
-- configure shifts first (there is no shift-management screen yet).
INSERT INTO shifts (organization_id, name, code, is_active)
SELECT o.id, label.name, label.code, TRUE
  FROM organizations o
  CROSS JOIN (VALUES ('Shift A', 'A'), ('Shift B', 'B'), ('Shift C', 'C'), ('General', 'G')) AS label(name, code)
 WHERE NOT EXISTS (
   SELECT 1 FROM shifts s WHERE s.organization_id = o.id AND s.code = label.code
 );

-- +migrate Down
DROP INDEX IF EXISTS attendance_shift_id_idx;
ALTER TABLE attendance DROP COLUMN IF EXISTS shift_id;
