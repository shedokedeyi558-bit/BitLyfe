-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add max_entries and current_entries to pill_packs
-- ─────────────────────────────────────────────────────────────────────────────
-- 
-- Purpose:
--   Allow admins to cap Specials packs by total entry count instead of/in addition to time.
--   When max_entries is set and current_entries >= max_entries, new attempts are rejected.
--
-- Specials-only:
--   These columns are informational for standard packs (both will be NULL).
--   They are actively used only for pack_type = 'special' packs.
--
-- Mutually independent:
--   If both quiz_expires_at and max_entries are set, whichever limit is hit first
--   closes the pack. Players see "QUIZ_EXPIRED" or "ENTRY_CAP_REACHED" accordingly.
--
-- Existing data:
--   Standard Pills packs: max_entries NULL, current_entries 0 (neutral)
--   Specials packs without cap: max_entries NULL, current_entries 0 (no cap enforced)
--   New Specials packs: max_entries set by admin, current_entries incremented per attempt
--

ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS max_entries INTEGER;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS current_entries INTEGER DEFAULT 0;

-- Add indexes for performance (optional but recommended for high-traffic packs)
CREATE INDEX IF NOT EXISTS idx_pill_packs_entry_tracking ON pill_packs(id, max_entries, current_entries)
  WHERE pack_type = 'special' OR is_vip = true;
