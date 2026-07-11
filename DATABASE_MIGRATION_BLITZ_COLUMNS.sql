-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add configurable prize fields to blitz_tournaments
-- Run this in the Supabase SQL editor to fix the missing column errors.
-- All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it's safe to
-- run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add max_participants (required — default 100 for existing rows)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS max_participants INTEGER NOT NULL DEFAULT 100;

-- Add cash_winner_count (how many ranks get cash)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS cash_winner_count INTEGER NOT NULL DEFAULT 1;

-- Add payout_distribution (JSON array, must match cash_winner_count length, sum to 100)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS payout_distribution JSONB NOT NULL DEFAULT '[100]';

-- Add total_payout_percent (% of revenue allocated to cash prizes)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS total_payout_percent DECIMAL(5,2) NOT NULL DEFAULT 40.00;

-- Add ticket_tier_percent (% of remaining participants who get free tickets, 0 = disabled)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS ticket_tier_percent DECIMAL(5,2) NOT NULL DEFAULT 10.00;

-- Add guaranteed_minimum (optional floor prize; platform absorbs gap if actual < minimum)
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS guaranteed_minimum INTEGER;

-- Drop platform_cut_percent if it still exists on the live DB
-- (platform share is now implicit: 100 - total_payout_percent)
ALTER TABLE blitz_tournaments
  DROP COLUMN IF EXISTS platform_cut_percent;

-- Create blitz_tickets table if it was never applied
CREATE TABLE IF NOT EXISTS blitz_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  source_tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE SET NULL,
  ticket_code TEXT UNIQUE NOT NULL,
  awarded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT CHECK (status IN ('unused', 'used', 'expired')) DEFAULT 'unused',
  used_on_tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blitz_tickets_player_id   ON blitz_tickets(player_id);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_ticket_code ON blitz_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_status      ON blitz_tickets(status);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_expires_at  ON blitz_tickets(expires_at);

-- Create player_limits table if it was never applied
CREATE TABLE IF NOT EXISTS player_limits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE UNIQUE,
  daily_limit INTEGER,
  weekly_limit INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_limits_player_id ON player_limits(player_id);

-- Add a UNIQUE constraint on transactions.reference to prevent duplicate deposits
-- at the DB level (idempotency guard). Partial index: only non-null references.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reference_unique
  ON transactions (reference)
  WHERE reference IS NOT NULL AND type = 'deposit';

-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add pack-level entry_fee and prize to pill_packs
-- Run in Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS entry_fee DECIMAL(10,2);
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS prize DECIMAL(10,2);
