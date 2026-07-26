-- Migration: Create specials_question_history table
-- Tracks which questions each player has seen per Specials pack.
-- Used to implement fresh-first question rotation: unseen questions
-- are served before cycling back to already-seen ones.

CREATE TABLE IF NOT EXISTS specials_question_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     UUID NOT NULL REFERENCES pill_packs(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id)    ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES pills(id)      ON DELETE CASCADE,
  shown_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (pack_id, player_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_sqh_pack_player
  ON specials_question_history (pack_id, player_id);

CREATE INDEX IF NOT EXISTS idx_sqh_player
  ON specials_question_history (player_id);

-- Grant access to the Supabase roles used by the backend
GRANT SELECT, INSERT, DELETE ON specials_question_history TO anon, authenticated, service_role;
