-- Migration: Add target_bank_size to pill_packs
-- Specials-scoped only — informational, does NOT affect activation logic.
-- Run in Supabase SQL editor.

ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS target_bank_size INTEGER;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'pill_packs' AND column_name = 'target_bank_size';
