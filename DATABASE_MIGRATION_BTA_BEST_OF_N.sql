-- Beat the Admin: Best-of-N rounds migration

-- ─── 1. admin_challenge_settings — add num_rounds ────────────────────────────
ALTER TABLE admin_challenge_settings
ADD COLUMN IF NOT EXISTS num_rounds INTEGER NOT NULL DEFAULT 5;

COMMENT ON COLUMN admin_challenge_settings.num_rounds IS
  'Number of rounds for best-of-N match. Must be odd. First to (num_rounds/2 + 0.5) round wins ends the match.';

-- ─── 2. admin_matches — add round tracking, keep old columns nullable ─────────
-- player_move/admin_move kept for backward compat but no longer written to for new matches
ALTER TABLE admin_matches
ADD COLUMN IF NOT EXISTS num_rounds          INTEGER NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS player_round_wins   INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS admin_round_wins    INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS current_round      INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN admin_matches.num_rounds        IS 'Snapshotted from settings at match creation';
COMMENT ON COLUMN admin_matches.player_round_wins IS 'Cumulative round wins for player';
COMMENT ON COLUMN admin_matches.admin_round_wins  IS 'Cumulative round wins for admin';
COMMENT ON COLUMN admin_matches.current_round     IS 'Round currently being played (1-indexed)';

-- ─── 3. admin_match_rounds — per-round record ────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_match_rounds (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id     UUID NOT NULL REFERENCES admin_matches(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  player_move  TEXT CHECK (player_move IN ('rock','paper','scissors')),
  admin_move   TEXT CHECK (admin_move  IN ('rock','paper','scissors')),
  result       TEXT CHECK (result IN ('player','admin','draw')) DEFAULT NULL,
  resolved_at  TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(match_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_amr_match_id ON admin_match_rounds(match_id);
CREATE INDEX IF NOT EXISTS idx_amr_match_round ON admin_match_rounds(match_id, round_number);

-- ─── Verify ───────────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'admin_challenge_settings'
  AND column_name = 'num_rounds';

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'admin_matches'
  AND column_name IN ('num_rounds','player_round_wins','admin_round_wins','current_round')
ORDER BY column_name;

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'admin_match_rounds';
