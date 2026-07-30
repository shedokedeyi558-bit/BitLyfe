-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Extend blitz prize types to support discount tickets
--
-- Changes:
--   1. Drop the restrictive CHECK on blitz_prizes.prize_type and replace it
--      with one that includes 'discount'.
--   2. Add discount_percent column to blitz_tickets (NULL = free / full entry).
--   3. Add position_prizes JSONB column to blitz_tournaments for explicit
--      per-position prize config (replaces ticket_tier_percent logic).
--
-- Safe to re-run: all statements use IF NOT EXISTS / IF EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Extend prize_type to allow 'discount'
ALTER TABLE blitz_prizes
  DROP CONSTRAINT IF EXISTS blitz_prizes_prize_type_check;

ALTER TABLE blitz_prizes
  ADD CONSTRAINT blitz_prizes_prize_type_check
  CHECK (prize_type IN ('cash', 'free_ticket', 'discount'));

-- 2. Add discount_percent to blitz_tickets
--    NULL  → free entry (existing behaviour)
--    50    → 50 % off entry fee
ALTER TABLE blitz_tickets
  ADD COLUMN IF NOT EXISTS discount_percent INTEGER DEFAULT NULL;

-- 3. Add position_prizes to blitz_tournaments
--    JSON array, one entry per explicit non-cash prize position, e.g.:
--    [
--      { "position": 2, "prize_type": "free_ticket" },
--      { "position": 3, "prize_type": "discount",  "discount_percent": 50 }
--    ]
--    NULL means fall back to legacy ticket_tier_percent behaviour.
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS position_prizes JSONB DEFAULT NULL;
