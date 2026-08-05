-- Migrate treasure_boxes to support multiple treasure slots per box.
-- treasure_slot_index (single int) → treasure_slot_indexes (JSONB array)
-- Existing rows get their single value wrapped in an array for backward compat.

-- Add new column
ALTER TABLE treasure_boxes
  ADD COLUMN IF NOT EXISTS treasure_slot_indexes JSONB DEFAULT NULL;

-- Migrate existing rows: wrap single integer in a JSON array
UPDATE treasure_boxes
SET treasure_slot_indexes = to_jsonb(ARRAY[treasure_slot_index])
WHERE treasure_slot_index IS NOT NULL
  AND (treasure_slot_indexes IS NULL OR treasure_slot_indexes = 'null'::jsonb);

-- Make the new column NOT NULL after migration
-- (run only after confirming all rows migrated)
-- ALTER TABLE treasure_boxes ALTER COLUMN treasure_slot_indexes SET NOT NULL;

-- Verify
SELECT id, treasure_slot_index, treasure_slot_indexes FROM treasure_boxes LIMIT 10;
