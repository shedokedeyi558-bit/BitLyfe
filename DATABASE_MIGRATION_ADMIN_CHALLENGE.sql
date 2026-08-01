-- Beat the Admin — data model migration
-- Run once in Supabase SQL editor before deploying routes.

-- ─── admin_challenge_settings ─────────────────────────────────────────────────
-- Single-row global settings for the Beat the Admin feature (same pattern as app_settings).

CREATE TABLE IF NOT EXISTS admin_challenge_settings (
  id                       INTEGER PRIMARY KEY DEFAULT 1,
  max_stake                INTEGER NOT NULL DEFAULT 500,
  min_stake                INTEGER NOT NULL DEFAULT 100,
  request_expiry_seconds   INTEGER NOT NULL DEFAULT 60,
  is_available             BOOLEAN NOT NULL DEFAULT false
);

-- Seed with default values. is_available starts OFF.
INSERT INTO admin_challenge_settings (id, max_stake, min_stake, request_expiry_seconds, is_available)
VALUES (1, 500, 100, 60, false)
ON CONFLICT (id) DO NOTHING;

-- ─── admin_challenge_requests ─────────────────────────────────────────────────
-- One row per player challenge request.

CREATE TABLE IF NOT EXISTS admin_challenge_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_type    TEXT NOT NULL CHECK (game_type IN ('rps')),   -- extensible: 'ludo' etc.
  stake        INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'expired', 'rejected'))
                 DEFAULT 'pending',
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  match_id     UUID DEFAULT NULL    -- set once approved and a match row is created
);

CREATE INDEX IF NOT EXISTS idx_acr_player_id   ON admin_challenge_requests(player_id);
CREATE INDEX IF NOT EXISTS idx_acr_status       ON admin_challenge_requests(status);
CREATE INDEX IF NOT EXISTS idx_acr_expires_at   ON admin_challenge_requests(expires_at);

-- ─── admin_matches ────────────────────────────────────────────────────────────
-- One row per actual match.

CREATE TABLE IF NOT EXISTS admin_matches (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id   UUID NOT NULL REFERENCES admin_challenge_requests(id) ON DELETE CASCADE,
  player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_type    TEXT NOT NULL CHECK (game_type IN ('rps')),
  stake        INTEGER NOT NULL,
  payout       INTEGER NOT NULL,      -- stake * 2 (pre-computed at creation)
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  player_move  TEXT CHECK (player_move IN ('rock', 'paper', 'scissors')),    -- null until submitted
  admin_move   TEXT CHECK (admin_move  IN ('rock', 'paper', 'scissors')),    -- null until submitted
  winner       TEXT CHECK (winner IN ('player', 'admin', 'draw')),           -- null until resolved
  started_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_am_player_id ON admin_matches(player_id);
CREATE INDEX IF NOT EXISTS idx_am_status    ON admin_matches(status);

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('admin_challenge_settings', 'admin_challenge_requests', 'admin_matches');
